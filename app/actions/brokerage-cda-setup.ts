"use server"

/**
 * Brokerage CDA setup — onboarding flag + template library.
 *
 * Some brokerages offer Commission Disbursement Authorizations (CDAs) and
 * some don't. This is a per-brokerage toggle captured during onboarding:
 *
 *   • offers_cda = true  → broker uploads CDA template PDFs (per state /
 *                          transaction type) so agents can pick the right
 *                          one when filling out a CDA at closing
 *   • offers_cda = false → set non_cda_payout_default; agents specify
 *                          per-transaction whether they want direct deposit
 *                          or a check
 *
 * This file is the canonical place to read/write that setup. The CDA
 * runtime workflow (cda-portal.ts) reads brokerages.offers_cda + picks
 * the right template_id at draft time.
 *
 * Tables used:
 *   brokerages (offers_cda, cda_onboarding_at, non_cda_payout_default)
 *   brokerage_cda_templates (the uploaded form library)
 *
 * No new tables introduced here.
 */

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { revalidatePath } from "next/cache"

// BROKERAGE-WIDE MONEY (m472). "CDA storage" is named in the owner's ruling among
// the financial gates team_lead is held out of, and this file writes
// public.brokerages (offers_cda / cda_onboarding_at / non_cda_payout_default) —
// a FINANCE table whose UPDATE policy is now is_brokerage_finance_admin(). A gate
// on the widened roster here would admit a team lead the database then refuses,
// and supabase-js resolves that refusal as zero rows with `error: null`.
//
// The ONE shared roster replaces the local literal. It adds broker_owner, whom
// the literal refused from their own brokerage's CDA setup, and drops
// 'superadmin', which is MEASURED dead as a user_type (zero live rows; the
// platform's one superadmin is user_type='admin' with platform_role='superadmin').
const isCdaSetupAdmin = (userType: string) => isBrokerageFinanceAdmin({ user_type: userType })

// ─── Onboarding answer + payout default ───────────────────────────────────

export async function setBrokerageCdaSettingAction(input: {
  offersCda:             boolean
  nonCdaPayoutDefault?:  "direct_deposit" | "check" | null
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }
  if (!isCdaSetupAdmin(auth.userType)) {
    return { success: false as const, error: "forbidden" }
  }

  const { error } = await supabase
    .from("brokerages")
    .update({
      offers_cda:             input.offersCda,
      cda_onboarding_at:      new Date().toISOString(),
      non_cda_payout_default: input.offersCda ? null : (input.nonCdaPayoutDefault ?? "direct_deposit"),
      updated_at:             new Date().toISOString(),
    })
    .eq("id", auth.brokerageId)

  if (error) return { success: false as const, error: error.message }
  revalidatePath("/dashboard/admin")
  return { success: true as const }
}

export async function getBrokerageCdaSettingAction() {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data } = await supabase
    .from("brokerages")
    .select("offers_cda, cda_onboarding_at, non_cda_payout_default")
    .eq("id", auth.brokerageId)
    .maybeSingle()

  return {
    success:        true as const,
    offersCda:      data?.offers_cda ?? null,
    onboardingAt:   data?.cda_onboarding_at ?? null,
    payoutDefault:  data?.non_cda_payout_default ?? null,
  }
}

// ─── Template library CRUD ────────────────────────────────────────────────

export async function uploadCdaTemplateAction(input: {
  name:            string
  description?:    string
  state?:          string                                   // 2-letter, optional (universal templates)
  transactionType?: "sale_buy" | "sale_sell" | "dual" | "lease" | "referral"
  pdfUrl:          string                                   // Vercel Blob URL
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }
  if (!isCdaSetupAdmin(auth.userType)) {
    return { success: false as const, error: "forbidden" }
  }
  if (!input.name?.trim()) return { success: false as const, error: "name_required" }
  if (!input.pdfUrl?.trim()) return { success: false as const, error: "pdf_url_required" }

  const { data, error } = await supabase
    .from("brokerage_cda_templates")
    .insert({
      brokerage_id:     auth.brokerageId,
      name:             input.name.trim(),
      description:      input.description?.trim() || null,
      state:            input.state ? input.state.trim().toUpperCase() : null,
      transaction_type: input.transactionType ?? null,
      pdf_url:          input.pdfUrl,
      uploaded_by:      auth.userId,
      is_active:        true,
    })
    .select("*")
    .single()

  if (error || !data) return { success: false as const, error: error?.message ?? "create_failed" }
  revalidatePath("/dashboard/admin")
  return { success: true as const, template: data }
}

export async function listCdaTemplatesAction(input?: {
  state?:           string
  transactionType?: string
  includeInactive?: boolean
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  let query = supabase
    .from("brokerage_cda_templates")
    .select("id, name, description, state, transaction_type, pdf_url, is_active, created_at, updated_at")
    .eq("brokerage_id", auth.brokerageId)
    .order("state", { ascending: true })
    .order("name", { ascending: true })

  if (!input?.includeInactive) query = query.eq("is_active", true)
  if (input?.state) query = query.eq("state", input.state.trim().toUpperCase())
  if (input?.transactionType) query = query.eq("transaction_type", input.transactionType)

  const { data, error } = await query
  if (error) return { success: false as const, error: error.message }
  return { success: true as const, templates: data ?? [] }
}

export async function updateCdaTemplateAction(input: {
  id:               string
  name?:            string
  description?:     string
  state?:           string
  transactionType?: string
  isActive?:        boolean
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }
  if (!isCdaSetupAdmin(auth.userType)) {
    return { success: false as const, error: "forbidden" }
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.name !== undefined)            updates.name             = input.name.trim()
  if (input.description !== undefined)     updates.description      = input.description?.trim() || null
  if (input.state !== undefined)           updates.state            = input.state ? input.state.trim().toUpperCase() : null
  if (input.transactionType !== undefined) updates.transaction_type = input.transactionType ?? null
  if (input.isActive !== undefined)        updates.is_active        = input.isActive

  const { error } = await supabase
    .from("brokerage_cda_templates")
    .update(updates)
    .eq("id", input.id)
    .eq("brokerage_id", auth.brokerageId)

  if (error) return { success: false as const, error: error.message }
  return { success: true as const }
}

export async function deactivateCdaTemplateAction(input: { id: string }) {
  return updateCdaTemplateAction({ id: input.id, isActive: false })
}
