"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity"
import { resolveAgentId } from "@/lib/kernel/agent-identity"

// Schedule automatic touchpoints after transaction closes
export async function schedulePastClientTouchpoints(contactId: string, transactionId: string, closeDate: Date) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const agentId = await resolveAgentId(supabase, user.id)
  if (!agentId) throw new Error("Agent profile not found")

  const touchpointSchedule = [
    { type: "post_close_3_day", daysAfter: 3, channel: "video" },
    { type: "post_close_30_day", daysAfter: 30, channel: "sms" },
    { type: "post_close_6_month", daysAfter: 180, channel: "email" },
    { type: "home_anniversary", daysAfter: 365, channel: "video" },
    { type: "referral_request", daysAfter: 18 * 30, channel: "sms" }, // 18 months
  ]

  const touchpoints = touchpointSchedule.map((schedule) => {
    const scheduledDate = new Date(closeDate)
    scheduledDate.setDate(scheduledDate.getDate() + schedule.daysAfter)

    return {
      contact_id: contactId,
      agent_id: agentId,
      touchpoint_type: schedule.type,
      channel: schedule.channel,
      scheduled_date: scheduledDate.toISOString().split("T")[0],
      related_transaction_id: transactionId,
      status: "scheduled",
    }
  })

  const { error } = await supabase.from("past_client_touchpoints").insert(touchpoints)

  if (error) throw error

  revalidatePath("/past-clients")
  return { success: true }
}

// Send anniversary message
export async function sendAnniversaryMessage(contactId: string, yearsAgo: number) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const agentId = await resolveAgentId(supabase, user.id)
  if (!agentId) throw new Error("Agent profile not found")

  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, email, phone")
    .eq("id", contactId)
    .single()

  if (!contact) throw new Error("Contact not found")

  const message = `Hi ${contact.first_name}! Can you believe it's been ${yearsAgo} year${yearsAgo > 1 ? "s" : ""} since you closed on your home? Time flies! Hope you're still loving it. Here's a quick market update for your neighborhood...`

  // Create touchpoint record
  const { error } = await supabase.from("past_client_touchpoints").insert({
    contact_id: contactId,
    agent_id: agentId,
    touchpoint_type: "home_anniversary",
    channel: "email",
    scheduled_date: new Date().toISOString().split("T")[0],
    sent_at: new Date().toISOString(),
    message_template: message,
    status: "sent",
  })

  if (error) throw error

  // Send via consolidated communications service
  const { sendAnniversaryMessage: sendAnniversaryComm } = await import("@/lib/services")
  await sendAnniversaryComm({
    contactId,
    email: contact.email ?? undefined,
    phone: contact.phone ?? undefined,
    message,
    occasionType: "Home Anniversary",
  })

  revalidatePath("/past-clients")
  return { success: true }
}

// Send birthday message
export async function sendBirthdayMessage(contactId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const agentId = await resolveAgentId(supabase, user.id)
  if (!agentId) throw new Error("Agent profile not found")

  const { data: contact } = await supabase.from("contacts").select("first_name, last_name").eq("id", contactId).single()

  if (!contact) throw new Error("Contact not found")

  const message = `Happy Birthday ${contact.first_name}! Wishing you an amazing year ahead!`

  const { error } = await supabase.from("past_client_touchpoints").insert({
    contact_id: contactId,
    agent_id: agentId,
    touchpoint_type: "birthday",
    channel: "sms",
    scheduled_date: new Date().toISOString().split("T")[0],
    sent_at: new Date().toISOString(),
    message_template: message,
    status: "sent",
  })

  if (error) throw error

  revalidatePath("/past-clients")
  return { success: true }
}

// Send referral request
export async function sendReferralRequest(contactId: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const agentId = await resolveAgentId(supabase, user.id)
  if (!agentId) throw new Error("Agent profile not found")

  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, email, phone")
    .eq("id", contactId)
    .single()

  if (!contact) throw new Error("Contact not found")

  const { data: agent } = await supabase.from("agents").select("full_name").eq("id", agentId).single()

  const message = `Hi ${contact.first_name}! I've been thinking about you - hope everything's going great with your home! Quick question: I'm trying to help more families find their perfect home. If you know anyone thinking about buying or selling, I'd love to give them the same experience you had. No pressure at all - just wanted to put it on your radar. ${agent?.full_name || "Your Agent"}`

  const { error } = await supabase.from("past_client_touchpoints").insert({
    contact_id: contactId,
    agent_id: agentId,
    touchpoint_type: "referral_request",
    channel: "sms",
    scheduled_date: new Date().toISOString().split("T")[0],
    sent_at: new Date().toISOString(),
    message_template: message,
    status: "sent",
  })

  if (error) throw error

  revalidatePath("/past-clients")
  return { success: true }
}

// Get past client contacts for agent
export async function getPastClientContacts() {
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
    .select("id, contact_id, status, close_date, sale_price")
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
    .from("past_client_touchpoints")
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

  const { data: touchpoints } = await supabase
    .from("past_client_touchpoints")
    .select("*")
    .eq("contact_id", contactId)
    .eq("status", "sent")

  const { data: referrals } = await supabase.from("referrals").select("*").eq("referring_contact_id", contactId)

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

  const { error } = await supabase.from("client_engagement_scores").upsert({
    contact_id: contactId,
    agent_id: agentId,
    engagement_score: engagementScore,
    referral_potential_score: referralPotentialScore,
    total_touchpoints: totalTouchpoints,
    touchpoints_responded: respondedTouchpoints,
    response_rate: responseRate,
    referrals_given: referralsGiven,
    last_calculated_at: new Date().toISOString(),
  })

  if (error) throw error

  return { engagementScore, referralPotentialScore }
}
