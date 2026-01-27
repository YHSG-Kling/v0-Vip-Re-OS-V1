"use server"

import { createClient } from "@/lib/supabase/server"

// Get referral partner stats
export async function getReferralPartnerStats() {
  const supabase = await createClient()

  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return { success: false, error: "Not authenticated" }
    }

    // Get partner profile
    const { data: partner } = await supabase
      .from("referral_partners")
      .select("*")
      .eq("user_id", user.id)
      .single()

    if (!partner) {
      return { 
        success: true, 
        stats: {
          referrals_sent: 0,
          in_escrow: 0,
          closed: 0,
          total_commission: 0,
        }
      }
    }

    // Get referral counts by status
    const { data: referrals } = await supabase
      .from("referrals")
      .select("status, commission_amount")
      .eq("partner_id", partner.id)

    const stats = {
      referrals_sent: referrals?.length || 0,
      in_escrow: referrals?.filter(r => r.status === "in_escrow").length || 0,
      closed: referrals?.filter(r => r.status === "closed").length || 0,
      total_commission: referrals?.filter(r => r.status === "closed")
        .reduce((sum, r) => sum + (r.commission_amount || 0), 0) || 0,
    }

    return { success: true, stats }
  } catch (error) {
    console.error("Error fetching partner stats:", error)
    return { success: false, error: "Failed to fetch partner stats" }
  }
}

// Get partner's referrals
export async function getPartnerReferrals() {
  const supabase = await createClient()

  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return { success: false, error: "Not authenticated" }
    }

    // Get partner profile
    const { data: partner } = await supabase
      .from("referral_partners")
      .select("id")
      .eq("user_id", user.id)
      .single()

    if (!partner) {
      return { success: true, referrals: [] }
    }

    // Get referrals
    const { data: referrals, error } = await supabase
      .from("referrals")
      .select(`
        *,
        contacts (first_name, last_name),
        agents (full_name)
      `)
      .eq("partner_id", partner.id)
      .order("created_at", { ascending: false })

    if (error) throw error

    // Map to expected format
    const mappedReferrals = (referrals || []).map(r => ({
      id: r.id,
      lead_name: r.contacts ? `${r.contacts.first_name || ""} ${r.contacts.last_name || ""}`.trim() : r.lead_name,
      budget: r.budget,
      area: r.area,
      status: r.status,
      created_at: r.created_at,
      assigned_agent: r.agents?.full_name,
      commission_amount: r.commission_amount,
    }))

    return { success: true, referrals: mappedReferrals }
  } catch (error) {
    console.error("Error fetching partner referrals:", error)
    return { success: false, error: "Failed to fetch referrals" }
  }
}

// Submit a new referral
export async function submitReferral(data: {
  leadName: string
  leadEmail: string
  leadPhone: string
  budget: number
  area: string
  notes?: string
}) {
  const supabase = await createClient()

  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return { success: false, error: "Not authenticated" }
    }

    // Get partner profile
    const { data: partner } = await supabase
      .from("referral_partners")
      .select("id, company_name")
      .eq("user_id", user.id)
      .single()

    if (!partner) {
      return { success: false, error: "Partner profile not found" }
    }

    // Create the referral
    const { data: referral, error } = await supabase
      .from("referrals")
      .insert({
        partner_id: partner.id,
        lead_name: data.leadName,
        lead_email: data.leadEmail,
        lead_phone: data.leadPhone,
        budget: data.budget,
        area: data.area,
        notes: data.notes,
        status: "new",
        created_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    return { success: true, referral }
  } catch (error) {
    console.error("Error submitting referral:", error)
    return { success: false, error: "Failed to submit referral" }
  }
}
