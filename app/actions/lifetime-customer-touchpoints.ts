"use server"

import { createClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity"
import { resolveAgentId } from "@/lib/kernel/agent-identity"

// System callers (e.g. the daily lifetime-touchpoints cron) have no user session,
// so they pass the owning agentId + a service-role client; UI callers pass neither
// and the acting agent is resolved from the session.
type TouchpointActorOpts = { agentId?: string; client?: SupabaseClient }

async function resolveTouchpointActor(opts: TouchpointActorOpts | undefined) {
  const supabase = opts?.client ?? (await createClient())
  let agentId = opts?.agentId
  if (!agentId) {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) throw new Error("Not authenticated")
    agentId = (await resolveAgentId(supabase, user.id)) ?? undefined
  }
  if (!agentId) throw new Error("Agent profile not found")
  const { data: agentRow } = await supabase
    .from("agents")
    .select("brokerage_id")
    .eq("id", agentId)
    .maybeSingle()
  return { supabase, agentId, brokerageId: agentRow?.brokerage_id ?? null }
}

// (REMOVED) scheduleLifetimeCustomerTouchpoints — the dead fixed-calendar scheduler. It had no callers
// and created the orphaned 'scheduled' rows nothing delivered. Lifetime nurture is now the situational
// model (newsletter baseline + the situational reel rail + equity/anniversary/life-event triggers).

// Send anniversary message
export async function sendAnniversaryMessage(contactId: string, yearsAgo: number, opts?: TouchpointActorOpts) {
  const { supabase, agentId, brokerageId } = await resolveTouchpointActor(opts)

  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, email, phone")
    .eq("id", contactId)
    .single()

  if (!contact) throw new Error("Contact not found")

  if (!contact.email) {
    return { success: false, error: "Contact has no email address for anniversary message" }
  }

  // Brand-voiced via the AI gateway (them-first, Fair-Housing redrafted), with the canned line as the
  // deterministic FALLBACK floor — the app's rule: client-facing copy is AI-generated in the agent's
  // voice, never a hardcoded script; the floor only ships if the gateway is down.
  const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
  const anniversaryCopy = await generateClientMessage({
    brokerageId, audience: "buyer", recipientFirstName: contact.first_name,
    purpose: `Warm ${yearsAgo}-year home-anniversary check-in to a past client — celebrate the milestone, stay genuinely in touch, and offer a quick neighborhood market update. No sales pressure.`,
    fallback: {
      subject: "Happy home anniversary!",
      body: `Hi ${contact.first_name}! Can you believe it's been ${yearsAgo} year${yearsAgo > 1 ? "s" : ""} since you closed on your home? Time flies! Hope you're still loving it. Here's a quick market update for your neighborhood...`,
    },
  })
  const message = anniversaryCopy.body

  // Create touchpoint record only after confirming email exists — status "sent" must be truthful
  const { error } = await supabase.from("lifetime_customer_touchpoints").insert({
    brokerage_id: brokerageId,
    contact_id: contactId,
    agent_id: agentId,
    touchpoint_type: "home_anniversary",
    channel: "email",
    scheduled_date: new Date().toISOString().split("T")[0],
    sent_date: new Date().toISOString().split("T")[0],
    engagement_data: { message },
    status: "sent",
  })

  if (error) throw error

  // Send via consolidated communications service — anniversary is email-only
  // to match the touchpoint record above (channel: "email")
  const { sendAnniversaryMessage: sendAnniversaryComm } = await import("@/lib/services")
  await sendAnniversaryComm({
    contactId,
    email: contact.email,
    message,
    occasionType: "Home Anniversary",
  })

  // Fire the personalized anniversary D-ID + cloned-voice video alongside the
  // email. Gated on contacts.video_opt_out + agent voice profile, idempotent
  // per calendar year via agent_intro_videos (m121). Never throws — a video
  // failure must not block the email touchpoint that just succeeded.
  if (agentId) {
    try {
      const { dispatchAnniversaryVideo } = await import("@/lib/video/intro-video-reactor")
      void dispatchAnniversaryVideo({
        brokerageId,
        contactId,
        agentId,   // agents.id from resolveAgentId — the reactor resolves to users.id internally
        yearsAgo,
        delivery: "portal",
      })
    } catch (err) {
      console.error("[anniversary] video dispatch failed:", err)
    }
  }

  revalidatePath("/lifetime-customers")
  return { success: true }
}

// Send birthday message
export async function sendBirthdayMessage(contactId: string, opts?: TouchpointActorOpts) {
  const { supabase, agentId, brokerageId } = await resolveTouchpointActor(opts)

  const { data: contact } = await supabase.from("contacts").select("first_name, last_name").eq("id", contactId).single()

  if (!contact) throw new Error("Contact not found")

  const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
  const birthdayCopy = await generateClientMessage({
    brokerageId, audience: "buyer", recipientFirstName: contact.first_name,
    purpose: "Short, warm birthday wish to a past client — genuine and personal, absolutely no sales pitch.",
    fallback: { subject: "Happy Birthday!", body: `Happy Birthday ${contact.first_name}! Wishing you an amazing year ahead!` },
  })
  const message = birthdayCopy.body

  const { error } = await supabase.from("lifetime_customer_touchpoints").insert({
    brokerage_id: brokerageId,
    contact_id: contactId,
    agent_id: agentId,
    touchpoint_type: "birthday",
    channel: "sms",
    scheduled_date: new Date().toISOString().split("T")[0],
    sent_date: new Date().toISOString().split("T")[0],
    engagement_data: { message },
    status: "sent",
  })

  if (error) throw error

  revalidatePath("/lifetime-customers")
  return { success: true }
}

// Send referral request
export async function sendReferralRequest(contactId: string, opts?: TouchpointActorOpts) {
  const { supabase, agentId, brokerageId } = await resolveTouchpointActor(opts)

  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, email, phone")
    .eq("id", contactId)
    .single()

  if (!contact) throw new Error("Contact not found")

  const { data: agent } = await supabase.from("agents").select("users(first_name, last_name)").eq("id", agentId).single()

  const agentFullName = [(agent?.users as any)?.first_name, (agent?.users as any)?.last_name].filter(Boolean).join(" ")

  const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
  const referralCopy = await generateClientMessage({
    brokerageId, audience: "buyer", recipientFirstName: contact.first_name,
    purpose: "Gentle referral ask to a happy past client — appreciative and warm, invite them to refer friends or family thinking of buying or selling, with zero pressure.",
    fallback: {
      subject: "A quick favor",
      body: `Hi ${contact.first_name}! I've been thinking about you - hope everything's going great with your home! Quick question: I'm trying to help more families find their perfect home. If you know anyone thinking about buying or selling, I'd love to give them the same experience you had. No pressure at all - just wanted to put it on your radar. ${agentFullName || "Your Agent"}`,
    },
  })
  const message = referralCopy.body

  const { error } = await supabase.from("lifetime_customer_touchpoints").insert({
    brokerage_id: brokerageId,
    contact_id: contactId,
    agent_id: agentId,
    touchpoint_type: "referral_request",
    channel: "sms",
    scheduled_date: new Date().toISOString().split("T")[0],
    sent_date: new Date().toISOString().split("T")[0],
    engagement_data: { message },
    status: "sent",
  })

  if (error) throw error

  revalidatePath("/lifetime-customers")
  return { success: true }
}

// Get past client contacts for agent
export async function getLifetimeCustomerContacts() {
  const context = await getAgentContext()
  if (!context?.agentId) {
    return { success: false, error: "Agent context not available", contacts: [] }
  }

  const { agentId, brokerageId } = context
  const supabase = await createClient()

  // Get contacts for this agent
  const { data: contacts, error: contactError } = await supabase
    .from("contacts")
    .select("*")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)

  if (contactError || !contacts) {
    console.error("Error fetching contacts:", contactError)
    return { success: false, error: contactError?.message, contacts: [] }
  }

  if (contacts.length === 0) {
    return { success: true, contacts: [] }
  }

  // Get closed transactions for these contacts
  const contactIds = contacts.map(c => c.id)
  const { data: transactions, error: transError } = await supabase
    .from("transactions")
    .select("id, contact_id, status, close_date, sale_price:purchase_price")
    .in("contact_id", contactIds)
    .in("status", ["closed", "sold"])

  if (transError) {
    console.error("Error fetching transactions:", transError)
    return { success: false, error: transError.message, contacts: [] }
  }

  if (!transactions || transactions.length === 0) {
    return { success: true, contacts: [] }
  }

  // Build map of transactions by contact_id
  const transactionMap = new Map()
  transactions.forEach(t => {
    if (!transactionMap.has(t.contact_id)) {
      transactionMap.set(t.contact_id, [])
    }
    transactionMap.get(t.contact_id).push(t)
  })

  // Merge contacts with their transactions
  const pastClients = contacts
    .filter(c => transactionMap.has(c.id))
    .map(c => ({
      ...c,
      transactions: transactionMap.get(c.id) || []
    }))
    .sort((a, b) => {
      const aLatest = Math.max(...(a.transactions?.map((t: any) => new Date(t.close_date).getTime()) || [0]))
      const bLatest = Math.max(...(b.transactions?.map((t: any) => new Date(t.close_date).getTime()) || [0]))
      return bLatest - aLatest
    })

  return { success: true, contacts: pastClients }
}

// Get touchpoint calendar for agent
export async function getTouchpointCalendar(month: number, year: number) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const startDate = new Date(year, month, 1)
  const endDate = new Date(year, month + 1, 0)

  const { data, error } = await supabase
    .from("lifetime_customer_touchpoints")
    .select("*, contacts(first_name, last_name)")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .gte("scheduled_date", startDate.toISOString().split("T")[0])
    .lte("scheduled_date", endDate.toISOString().split("T")[0])
    .order("scheduled_date")

  if (error) throw error
  return data
}

// Calculate engagement score
export async function calculateEngagementScore(contactId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const agentId = await resolveAgentId(supabase, user.id)
  if (!agentId) throw new Error("Agent profile not found")
  // client_engagement_scores.brokerage_id is NOT NULL — resolve from the agent.
  const { data: agentRow } = await supabase
    .from("agents").select("brokerage_id").eq("id", agentId).maybeSingle()
  const brokerageId = agentRow?.brokerage_id ?? null

  const { data: touchpoints } = await supabase
    .from("lifetime_customer_touchpoints")
    .select("*")
    .eq("contact_id", contactId)
    .eq("status", "sent")

  // referrals given BY this contact: canonical column is referred_by (text).
  // tenant anchor (scope burn-down): pinned to the resolved agent's brokerage.
  const { data: referrals } = await supabase
    .from("referrals")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("referred_by", contactId)

  const totalTouchpoints = touchpoints?.length || 0
  const respondedTouchpoints = touchpoints?.filter((t) => t.engagement_data?.replied).length || 0
  const responseRate = totalTouchpoints > 0 ? (respondedTouchpoints / totalTouchpoints) * 100 : 0
  const referralsGiven = referrals?.length || 0

  // Calculate engagement score (0-100)
  const engagementScore = Math.min(100, Math.round(responseRate * 0.6 + referralsGiven * 10 + totalTouchpoints * 2))

  // Calculate referral potential score
  const referralPotentialScore = Math.min(
    100,
    Math.round(responseRate * 0.4 + engagementScore * 0.4 + referralsGiven * 5),
  )

  // client_engagement_scores real columns: score/touchpoints_count/referrals_given/
  // last_interaction/calculated_at (no engagement_score/referral_potential_score/
  // total_touchpoints/touchpoints_responded/response_rate/last_calculated_at). UNIQUE(contact_id).
  // referralPotentialScore/respondedTouchpoints/responseRate remain computed for the return value.
  const { error } = await supabase.from("client_engagement_scores").upsert({
    brokerage_id: brokerageId,
    contact_id: contactId,
    agent_id: agentId,
    score: engagementScore,
    touchpoints_count: totalTouchpoints,
    referrals_given: referralsGiven,
    last_interaction: new Date().toISOString(),
    calculated_at: new Date().toISOString(),
  }, { onConflict: "contact_id" })

  if (error) throw error

  return { engagementScore, referralPotentialScore }
}
