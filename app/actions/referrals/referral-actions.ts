"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { captureContact } from "@/lib/contact-pipeline/contact-capture"
import { KernelEvent } from "@/lib/kernel/events"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type ReferralPartnerRow = {
  id: string
  agent_id: string
  brokerage_id: string
  partner_name: string
  partner_type: string
  agreement_type: string
  commission_split_percentage: number | null
  referral_fee_flat: number | null
  total_referrals_sent: number
  total_referrals_received: number
  total_value_generated: number
  active: boolean
  created_at: string
}

export type ReferralRow = {
  id: string
  brokerage_id: string
  agent_id: string
  partner_id: string
  referred_contact_id: string | null
  status: "received" | "contacted" | "qualified" | "under_contract" | "closed"
  referral_source: string | null
  commission_amount: number | null
  closed_at: string | null
  created_at: string
  referral_partners?: Pick<ReferralPartnerRow, "partner_name" | "partner_type"> | null
}

export type CreateReferralParams = {
  partnerId: string
  referralSource?: string
  commissionAmount?: number
  referredPerson?: {
    firstName?: string
    lastName?: string
    email?: string
    phone?: string
  }
}

export type CreatePartnerParams = {
  partnerName: string
  partnerType: string
  agreementType: string
  commissionSplitPercentage?: number
  referralFeeFlat?: number
}

// ─── ACTIONS ─────────────────────────────────────────────────────────────────

export async function createReferral(params: CreateReferralParams): Promise<{ id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Unauthorized")

  const { agentId, brokerageId } = await getAgentContext()
  const db = createServiceClient()

  // Step 1: If referred person has email/phone → call captureContact() (Track B)
  let referredContactId: string | null = null
  if (params.referredPerson) {
    const { firstName, lastName, email, phone } = params.referredPerson
    if (email || phone) {
      const result = await captureContact({
        brokerageId: brokerageId ?? "",
        first_name: firstName ?? null,
        last_name: lastName ?? null,
        email: email ?? null,
        phone: phone ?? null,
        source: "referral",
        tcpa_consent: false,
      })
      referredContactId = result.contactId
    }
  }

  // Step 2: INSERT referrals
  const { data: referral, error: insertError } = await db
    .from("referrals")
    .insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      partner_id: params.partnerId,
      referred_contact_id: referredContactId,
      status: "received",
      referral_source: params.referralSource ?? null,
      commission_amount: params.commissionAmount ?? null,
    })
    .select("id")
    .single()

  if (insertError || !referral) {
    throw new Error(`Failed to create referral: ${insertError?.message ?? "no row returned"}`)
  }

  // Step 3: UPDATE referral_partners SET total_referrals_received += 1
  const { error: updateError } = await db.rpc("increment_referral_received", {
    p_partner_id: params.partnerId,
  })
  // Non-fatal if RPC errors — fall back to a read-then-increment update
  if (updateError) {
    const { data: partner } = await db
      .from("referral_partners")
      .select("total_referrals_received")
      .eq("id", params.partnerId)
      .maybeSingle()
    await db
      .from("referral_partners")
      .update({ total_referrals_received: (partner?.total_referrals_received ?? 0) + 1 })
      .eq("id", params.partnerId)
  }

  // Step 4: INSERT lifecycle_events
  await db.from("lifecycle_events").insert({
    entity_type:   "contact",
    entity_id:     referredContactId ?? referral.id,
    brokerage_id:  brokerageId,
    event_type:    KernelEvent.REFERRAL_RECEIVED,
    actor_user_id: agentId,
    metadata: {
      referral_id: referral.id,
      partner_id:  params.partnerId,
      source:      params.referralSource,
    },
  })

  return { id: referral.id }
}

export async function updateReferralStatus(
  referralId: string,
  status: ReferralRow["status"],
  closedData?: { commissionAmount?: number }
): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Unauthorized")

  const { agentId, brokerageId } = await getAgentContext()
  const db = createServiceClient()

  const updates: Partial<ReferralRow> = { status }
  if (status === "closed") {
    updates.closed_at = new Date().toISOString()
    if (closedData?.commissionAmount !== undefined) {
      updates.commission_amount = closedData.commissionAmount
    }
  }

  const { error } = await db
    .from("referrals")
    .update(updates)
    .eq("id", referralId)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)

  if (error) throw new Error(`Failed to update referral: ${error.message}`)

  // If closed: bump total_value_generated on partner
  if (status === "closed" && closedData?.commissionAmount) {
    const { data: ref } = await db
      .from("referrals")
      .select("partner_id, commission_amount")
      .eq("id", referralId)
      .single()

    if (ref?.partner_id) {
      const { data: partner } = await db
        .from("referral_partners")
        .select("total_value_generated")
        .eq("id", ref.partner_id)
        .single()

      if (partner) {
        await db
          .from("referral_partners")
          .update({
            total_value_generated:
              (partner.total_value_generated ?? 0) + (closedData.commissionAmount ?? 0),
          })
          .eq("id", ref.partner_id)
      }
    }
  }
}

export async function sendReferralThankYou(referralId: string): Promise<{ success: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Unauthorized")

  const { agentId, brokerageId } = await getAgentContext()
  const db = createServiceClient()

  const { error } = await db
    .from("referrals")
    .update({
      thank_you_sent: true,
      thank_you_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", referralId)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)

  if (error) throw new Error(`Failed to send thank you: ${error.message}`)
  return { success: true }
}

export async function createPartner(params: CreatePartnerParams): Promise<{ id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Unauthorized")

  const { agentId, brokerageId } = await getAgentContext()
  const db = createServiceClient()

  // RESPA GATE — the platform structurally blocks a referral/kickback fee against a settlement-service
  // partner (lender, title, attorney, appraiser, inspector, surveyor). The refusal is recorded on the
  // immutable compliance ledger; the agent sees the RESPA kickback notice, not a generic error.
  const hasFee = (params.referralFeeFlat ?? 0) > 0 || (params.commissionSplitPercentage ?? 0) > 0
  if (hasFee) {
    const { guardVendorReferralFee, respaKickbackNotice } = await import("@/lib/compliance/vendor-respa")
    const verdict = await guardVendorReferralFee(db, {
      brokerageId,
      actorUserId: user.id,
      actorRole: "agent",
      category: params.partnerType,
      partnerName: params.partnerName,
      hasFee,
      feeType: (params.referralFeeFlat ?? 0) > 0 ? "flat_referral_fee" : "commission_split",
    })
    if (!verdict.allowed) {
      throw new Error(`${verdict.reason ?? "Referral fee not permitted."}\n\n${respaKickbackNotice()}`)
    }
  }

  const { data, error } = await db
    .from("referral_partners")
    .insert({
      agent_id: agentId,
      brokerage_id: brokerageId,
      partner_name: params.partnerName,
      partner_type: params.partnerType,
      agreement_type: params.agreementType,
      commission_split_percentage: params.commissionSplitPercentage ?? null,
      referral_fee_flat: params.referralFeeFlat ?? null,
      total_referrals_sent: 0,
      total_referrals_received: 0,
      total_value_generated: 0,
      active: true,
    })
    .select("id")
    .single()

  if (error || !data) throw new Error(`Failed to create partner: ${error?.message ?? "no row"}`)
  return { id: data.id }
}

/**
 * Delete a partner record by ID. Used for compensating-transaction cleanup when
 * referral creation fails after a partner has already been inserted.
 */
export async function deletePartner(partnerId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Unauthorized")

  const { agentId, brokerageId } = await getAgentContext()
  const db = createServiceClient()

  const { data: deleted, error } = await db
    .from("referral_partners")
    .delete()
    .eq("id", partnerId)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .select("id")

  if (error) throw new Error(`Failed to delete partner: ${error.message}`)
  if (!deleted || deleted.length === 0) {
    console.warn(`[deletePartner] No row deleted for partnerId=${partnerId} — may have already been removed or ownership mismatch`)
  }
}

export async function listPartnersWithReferrals(): Promise<{
  partners: ReferralPartnerRow[]
  referrals: ReferralRow[]
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Unauthorized")

  const { agentId, brokerageId } = await getAgentContext()
  const db = createServiceClient()

  const [{ data: partners }, { data: referrals }] = await Promise.all([
    db
      .from("referral_partners")
      .select("*")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .eq("active", true)
      .order("created_at", { ascending: false }),
    db
      .from("referrals")
      .select("*, referral_partners(partner_name, partner_type)")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(200),
  ])

  return {
    partners: (partners ?? []) as ReferralPartnerRow[],
    referrals: (referrals ?? []) as ReferralRow[],
  }
}
