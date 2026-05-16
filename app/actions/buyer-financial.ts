"use server"

/**
 * Buyer Financial Verification — Server Actions
 *
 * Writes to: client_documents, buyer_financial_profiles,
 *            credit_partner_referrals, notifications, activities
 * Calls: emitLifecycleTransition from lib/buyer-lifecycle/lifecycle-logger.ts
 */

import { createServiceClient } from "@/lib/supabase/service"
import { requireWriteContext } from "@/lib/kernel/identity"
import { emitLifecycleTransition } from "@/lib/buyer-lifecycle/lifecycle-logger"

// ─── UPSERT FINANCIAL PROFILE ─────────────────────────────────────────────────

export async function upsertFinancialProfile(params: {
  contactId: string
  brokerageId: string
  agentUserId: string
  financeType: "conventional" | "fha" | "va" | "cash" | "other"
  isCashBuyer: boolean
  preApprovalAmount?: number
  preApprovalLender?: string
  preApprovalExpiresAt?: string
  preApprovalLetterDocId?: string
  proofOfFundsDocId?: string
  downPaymentPercent?: number
  estimatedMonthlyBudget?: number
}): Promise<{ success: boolean; profileId?: string; error?: string }> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("buyer_financial_profiles")
    .upsert(
      {
        contact_id:                   params.contactId,
        brokerage_id:                 params.brokerageId,
        agent_user_id:                params.agentUserId,
        finance_type:                 params.financeType,
        is_cash_buyer:                params.isCashBuyer,
        pre_approval_amount:          params.preApprovalAmount ?? null,
        pre_approval_lender:          params.preApprovalLender ?? null,
        pre_approval_expires_at:      params.preApprovalExpiresAt ?? null,
        pre_approval_letter_doc_id:   params.preApprovalLetterDocId ?? null,
        proof_of_funds_doc_id:        params.proofOfFundsDocId ?? null,
        down_payment_percent:         params.downPaymentPercent ?? null,
        estimated_monthly_budget:     params.estimatedMonthlyBudget ?? null,
        updated_at:                   new Date().toISOString(),
      },
      { onConflict: "contact_id" }
    )
    .select("id")
    .single()

  if (error) return { success: false, error: error.message }
  return { success: true, profileId: data.id }
}

// ─── RECORD DOCUMENT UPLOAD ───────────────────────────────────────────────────

export async function recordDocumentUpload(params: {
  contactId: string
  brokerageId: string
  uploadedBy: string
  documentName: string
  documentUrl: string
  docCategory: "pre_approval_letter" | "proof_of_funds"
  verificationAmount?: number
  verificationLender?: string
  expirationDate?: string
}): Promise<{ success: boolean; docId?: string; error?: string }> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("client_documents")
    .insert({
      contact_id:               params.contactId,
      brokerage_id:             params.brokerageId,
      uploaded_by:              params.uploadedBy,
      document_name:            params.documentName,
      document_url:             params.documentUrl,
      document_type:            params.docCategory,
      doc_category:             params.docCategory,
      is_financial_verification: true,
      verification_amount:      params.verificationAmount ?? null,
      verification_lender:      params.verificationLender ?? null,
      expiration_date:          params.expirationDate ?? null,
    })
    .select("id")
    .single()

  if (error) return { success: false, error: error.message }
  return { success: true, docId: data.id }
}

// ─── MARK AS FINANCIALLY VERIFIED ────────────────────────────────────────────

export async function markFinanciallyVerified(params: {
  contactId: string
  brokerageId: string
  agentUserId: string
}): Promise<{ success: boolean; error?: string }> {
  // Auth: caller must be an authenticated agent/admin in the contact's brokerage.
  // Without this, service-client bypassed RLS and any caller could mark any
  // contact as financially verified.
  const ctx = await requireWriteContext()
  if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
  if (ctx.brokerageId !== params.brokerageId) {
    return { success: false, error: "Forbidden: brokerage mismatch" }
  }

  const supabase = createServiceClient()

  // Verify the contact is actually in the caller's brokerage before mutating.
  const { data: contactRow } = await supabase
    .from("contacts")
    .select("brokerage_id, agent_id")
    .eq("id", params.contactId)
    .maybeSingle()
  if (!contactRow) return { success: false, error: "Contact not found" }
  if (contactRow.brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Forbidden: contact in another brokerage" }
  }

  // 1. Update buyer_financial_profiles
  const { error: profileError } = await supabase
    .from("buyer_financial_profiles")
    .update({
      verified:    true,
      verified_by: params.agentUserId,
      verified_at: new Date().toISOString(),
      updated_at:  new Date().toISOString(),
    })
    .eq("contact_id", params.contactId)

  if (profileError) return { success: false, error: profileError.message }

  // 2. Emit lifecycle transition → BUYER_FINANCIALLY_VERIFIED
  const transitionResult = await emitLifecycleTransition({
    contactId:     params.contactId,
    brokerageId:   params.brokerageId,
    fromState:     "BUYER_CONTACT_CREATED" as any,
    toState:       "BUYER_FINANCIALLY_VERIFIED" as any,
    triggeredBy:   "agent",
    authorityRole: "agent",
    userId:        params.agentUserId,
    sourceSystem:  "buyer_dashboard",
  })

  if (!transitionResult.success) {
    return { success: false, error: transitionResult.error }
  }

  return { success: true }
}

// ─── CONNECT BUYER TO LENDER ─────────────────────────────────────────────────

export async function connectBuyerToLender(params: {
  contactId: string
  brokerageId: string
  agentUserId: string
  agentName: string
  buyerName: string
  partnerId: string
  partnerName: string
  lenderUserId?: string
}): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()

  // 1. Insert credit_partner_referral
  const { error: referralError } = await supabase
    .from("credit_partner_referrals")
    .insert({
      contact_id:    params.contactId,
      partner_name:  params.partnerName,
      referral_date: new Date().toISOString().split("T")[0],
      status:        "referred",
      notes:         `Referred by agent ${params.agentName} via buyer dashboard`,
    })

  if (referralError) return { success: false, error: referralError.message }

  // 2. UPSERT buyer_financial_profiles lender referral
  const { error: profileError } = await supabase
    .from("buyer_financial_profiles")
    .upsert(
      {
        contact_id:                  params.contactId,
        brokerage_id:                params.brokerageId,
        agent_user_id:               params.agentUserId,
        finance_type:                "conventional",
        is_cash_buyer:               false,
        lender_referral_status:      "referred",
        lender_referred_partner_id:  params.partnerId,
        updated_at:                  new Date().toISOString(),
      },
      { onConflict: "contact_id" }
    )

  if (profileError) return { success: false, error: profileError.message }

  // 3. Notify lender if they have an account
  if (params.lenderUserId) {
    await supabase.from("notifications").insert({
      user_id:     params.lenderUserId,
      brokerage_id: params.brokerageId,
      type:        "lender_introduction",
      title:       `New buyer introduction: ${params.buyerName}`,
      body:        `Agent ${params.agentName} has introduced a buyer who may need financing assistance.`,
      entity_type: "contact",
      entity_id:   params.contactId,
      priority:    "high",
      channel:     "in_app",
    })
  }

  // 4. Log activity
  await supabase.from("activities").insert({
    brokerage_id:  params.brokerageId,
    agent_id:      params.agentUserId,
    contact_id:    params.contactId,
    activity_type: "lender.introduced",
    title:         `Lender introduction sent to ${params.partnerName}`,
    entity_type:   "contact",
    notes:         `Buyer ${params.buyerName} introduced to lender ${params.partnerName}`,
    status:        "completed",
  })

  return { success: true }
}

// ─── LOAD FINANCIAL PROFILE ───────────────────────────────────────────────────

export async function loadFinancialProfile(params: {
  contactId: string
}): Promise<{ success: boolean; profile?: any; documents?: any[]; error?: string }> {
  const supabase = createServiceClient()

  const [{ data: profile }, { data: documents }] = await Promise.all([
    supabase
      .from("buyer_financial_profiles")
      .select("*")
      .eq("contact_id", params.contactId)
      .maybeSingle(),
    supabase
      .from("client_documents")
      .select("id, document_name, document_url, doc_category, is_financial_verification, verification_amount, verification_lender, expiration_date, created_at")
      .eq("contact_id", params.contactId)
      .eq("is_financial_verification", true)
      .order("created_at", { ascending: false }),
  ])

  return { success: true, profile: profile ?? null, documents: documents ?? [] }
}

// ─── GET BROKERAGE LENDER USERS ───────────────────────────────────────────────

export async function getBrokerageLenders(params: {
  brokerageId: string
}): Promise<{ success: boolean; lenders?: { id: string; full_name: string; email: string | null; phone: string | null }[]; error?: string }> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("users")
    .select("id, full_name, email, phone")
    .eq("brokerage_id", params.brokerageId)
    .eq("user_type", "lender")
    .eq("is_active", true)
    .order("full_name", { ascending: true })

  if (error) return { success: false, error: error.message }
  return { success: true, lenders: (data ?? []).map((u) => ({ id: u.id, full_name: u.full_name ?? "Unnamed Lender", email: u.email ?? null, phone: u.phone ?? null })) }
}

// ─── LOAD MORTGAGE BROKER PARTNERS ───────────────────────────────────────────

export async function loadMortgageBrokers(params: {
  agentUserId: string
}): Promise<{ success: boolean; partners?: any[]; error?: string }> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("referral_partners")
    .select("id, partner_name, company_name, phone, email")
    .eq("agent_id", params.agentUserId)
    .eq("partner_type", "mortgage_broker")
    .eq("active", true)
    .limit(3)

  if (error) return { success: false, error: error.message }
  return { success: true, partners: data ?? [] }
}
