"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity"

// Create new referral
// Live schema: referrals(id, referral_name, status, referral_source, notes,
//   value_estimate, commission_potential, source_contact_name, referred_by,
//   gift_sent, thank_you_sent, brokerage_id, agent_id, referred_contact_id,
//   referred_lead_id, partner_id, created_at, updated_at, converted_at,
//   closed_at, gift_sent_at, thank_you_sent_at, commission_amount)
export async function createReferral(params: {
  referralName: string
  referredBy?: string
  sourceContactName?: string
  referralSource?: string
  valueEstimate?: number
  commissionPotential?: number
  notes?: string
  referredContactId?: string
  referredLeadId?: string
  partnerId?: string
}) {
  const { agentId, brokerageId } = await getAgentContext()
  if (!agentId) throw new Error("Not authenticated")
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("referrals")
    .insert({
      agent_id:             agentId,
      brokerage_id:         brokerageId,
      referral_name:        params.referralName,
      referred_by:          params.referredBy          ?? null,
      source_contact_name:  params.sourceContactName   ?? null,
      referral_source:      params.referralSource       ?? null,
      value_estimate:       params.valueEstimate        ?? null,
      commission_potential: params.commissionPotential  ?? null,
      notes:                params.notes                ?? null,
      referred_contact_id:  params.referredContactId   ?? null,
      referred_lead_id:     params.referredLeadId      ?? null,
      partner_id:           params.partnerId            ?? null,
      gift_sent:            false,
      thank_you_sent:       false,
      status:               "new",
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/referrals")
  return data
}

// Update referral status
// Only writes columns that exist: status, updated_at, converted_at (on converted), closed_at (on closed)
export async function updateReferralStatus(referralId: string, status: string) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const updates: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  }

  if (status === "converted") updates.converted_at = new Date().toISOString()
  if (status === "closed")    updates.closed_at    = new Date().toISOString()

  const { error } = await supabase
    .from("referrals")
    .update(updates)
    .eq("id",           referralId)
    .eq("agent_id",     agentId)
    .eq("brokerage_id", brokerageId)

  if (error) throw error

  revalidatePath("/referrals")
  return { success: true }
}

// Send referral thank you
// Writes: thank_you_sent=true, thank_you_sent_at=now (columns that exist in live schema)
export async function sendReferralThankYou(referralId: string) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { error } = await supabase
    .from("referrals")
    .update({
      thank_you_sent:    true,
      thank_you_sent_at: new Date().toISOString(),
      updated_at:        new Date().toISOString(),
    })
    .eq("id",           referralId)
    .eq("agent_id",     agentId)
    .eq("brokerage_id", brokerageId)

  if (error) throw error

  revalidatePath("/referrals")
  return { success: true }
}

// Get all referrals for the agent
// Note: referrals.referred_contact_id FK to contacts (not referring_contact_id)
export async function getReferrals() {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("referrals")
    .select("*")
    .eq("agent_id",     agentId)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  if (error) throw error
  return data || []
}

// Get referral ROI stats
export async function getReferralROI(dateRange?: { start: string; end: string }) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  let query = supabase.from("referrals").select("*").eq("agent_id", agentId).eq("brokerage_id", brokerageId)

  if (dateRange) {
    query = query.gte("created_at", dateRange.start).lte("created_at", dateRange.end)
  }

  const { data, error } = await query

  if (error) throw error

  const stats = {
    totalReferrals:   data?.length || 0,
    identified:       data?.filter((r) => r.status === "identified").length || 0,
    asked:            data?.filter((r) => r.status === "asked").length || 0,
    received:         data?.filter((r) => r.status === "received").length || 0,
    converting:       data?.filter((r) => r.status === "converting").length || 0,
    converted:        data?.filter((r) => r.status === "converted").length || 0,
    totalValue:       data?.reduce((sum: number, r) => sum + (r.commission_amount  || 0), 0) || 0,
    potentialValue:   data?.reduce((sum: number, r) => sum + (r.value_estimate     || 0), 0) || 0,
    conversionRate:   data?.length ? (data.filter((r) => r.status === "converted").length / data.length) * 100 : 0,
  }

  return stats
}

// Get referral leaderboard — groups by referred_by (text field, not FK)
export async function getReferralLeaderboard() {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("referrals")
    .select("referred_by, referral_name, status")
    .eq("agent_id",     agentId)
    .eq("brokerage_id", brokerageId)
    .not("referred_by", "is", null)

  if (error) throw error

  const counts = (data ?? []).reduce((acc: Record<string, { referredBy: string; count: number; converted: number }>, ref) => {
    const key = ref.referred_by as string
    if (!acc[key]) acc[key] = { referredBy: key, count: 0, converted: 0 }
    acc[key].count++
    if (ref.status === "converted") acc[key].converted++
    return acc
  }, {})

  return Object.values(counts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
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
  const { agentId, brokerageId } = await getAgentContext()
  if (!agentId) throw new Error("Not authenticated")
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("referral_partners")
    .insert({
      agent_id: agentId,
      brokerage_id: brokerageId,
      ...params,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/agent/referrals")
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
