"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity/get-agent-context"

// Create new referral
export async function createReferral(params: {
  referringContactId: string
  referredName: string
  referredPhone?: string
  referredEmail?: string
  source: string
  potentialValue?: number
  notes?: string
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: userProfile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()

  const { data, error } = await supabase
    .from("referrals")
    .insert({
      referring_contact_id: params.referringContactId,
      agent_id: user.id,
      brokerage_id: userProfile?.brokerage_id,
      referred_name: params.referredName,
      referred_phone: params.referredPhone,
      referred_email: params.referredEmail,
      source: params.source,
      potential_value: params.potentialValue,
      notes: params.notes,
      status: "new",
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/referrals")
  return data
}

// Update referral status
export async function updateReferralStatus(referralId: string, status: string) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const updates: any = { status }

  // Set dates based on status
  const dateField = {
    contacted: "contacted_date",
    qualified: "qualified_date",
    under_contract: "contract_date",
    closed: "closed_date",
  }[status]

  if (dateField) {
    updates[dateField] = new Date().toISOString().split("T")[0]
  }

  // Set reward tier
  if (["contacted", "qualified", "under_contract", "closed"].includes(status)) {
    updates.reward_tier = status
  }

  const { error } = await supabase.from("referrals").update(updates).eq("id", referralId).eq("agent_id", agentId).eq("brokerage_id", brokerageId)

  if (error) throw error

  revalidatePath("/referrals")
  return { success: true }
}

// Send referral thank you
export async function sendReferralThankYou(referralId: string, rewardType: string) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const rewardDescriptions = {
    contacted: "$25 coffee gift card",
    qualified: "$100 restaurant gift card",
    under_contract: "$250 experience gift",
    closed: "$500+ personalized gift",
  }

  const { error } = await supabase
    .from("referrals")
    .update({
      thank_you_sent: true,
      thank_you_sent_date: new Date().toISOString().split("T")[0],
      reward_description: rewardDescriptions[rewardType as keyof typeof rewardDescriptions],
    })
    .eq("id", referralId)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)

  if (error) throw error

  revalidatePath("/referrals")
  return { success: true }
}

// Get all referrals for the agent
export async function getReferrals() {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("referrals")
    .select("*, contacts!referring_contact_id(first_name, last_name, email, phone)")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .order("referral_date", { ascending: false })

  if (error) throw error
  return data || []
}

// Get referral ROI stats
export async function getReferralROI(dateRange?: { start: string; end: string }) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  let query = supabase.from("referrals").select("*").eq("agent_id", agentId).eq("brokerage_id", brokerageId)

  if (dateRange) {
    query = query.gte("referral_date", dateRange.start).lte("referral_date", dateRange.end)
  }

  const { data, error } = await query

  if (error) throw error

  const stats = {
    totalReferrals: data?.length || 0,
    contacted: data?.filter((r) => r.status === "contacted").length || 0,
    qualified: data?.filter((r) => r.status === "qualified").length || 0,
    underContract: data?.filter((r) => r.status === "under_contract").length || 0,
    closed: data?.filter((r) => r.status === "closed").length || 0,
    totalValue: data?.reduce((sum, r) => sum + (r.actual_value || 0), 0) || 0,
    potentialValue: data?.reduce((sum, r) => sum + (r.potential_value || 0), 0) || 0,
    conversionRate: data?.length ? (data.filter((r) => r.status === "closed").length / data.length) * 100 : 0,
  }

  return stats
}

// Get referral leaderboard (top referrers)
export async function getReferralLeaderboard() {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("referrals")
    .select("referring_contact_id, contacts(first_name, last_name)")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)

  if (error) throw error

  // Group by referring contact and count
  const counts = data?.reduce((acc: any, ref) => {
    const id = ref.referring_contact_id
    if (!acc[id]) {
      acc[id] = {
        contact: ref.contacts,
        count: 0,
      }
    }
    acc[id].count++
    return acc
  }, {})

  const leaderboard = Object.values(counts || {})
    .sort((a: any, b: any) => b.count - a.count)
    .slice(0, 10)

  return leaderboard
}

// Create referral partner
export async function createReferralPartner(params: {
  partnerName: string
  partnerType: string
  companyName?: string
  email?: string
  phone?: string
  agreementType?: string
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: userProfile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()

  const { data, error } = await supabase
    .from("referral_partners")
    .insert({
      agent_id: user.id,
      brokerage_id: userProfile?.brokerage_id,
      ...params,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/referral-partners")
  return data
}

// Get all referral partners
export async function getReferralPartners() {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("referral_partners")
    .select("*")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .order("partner_name")

  if (error) throw error
  return data
}
