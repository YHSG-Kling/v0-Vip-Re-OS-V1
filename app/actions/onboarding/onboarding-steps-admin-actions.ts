"use server"

// app/actions/onboarding/onboarding-steps-admin-actions.ts
// Server actions for admin/broker/superadmin management of brokerage-specific onboarding steps.
// No direct DB access. No any. Delegates entirely to kernel functions.

import { createClient } from "@/lib/supabase/server"
import {
  createOnboardingStepForBrokerage,
  updateOnboardingStepForBrokerage,
  deleteOnboardingStepForBrokerage,
} from "@/lib/kernel"
import type { OnboardingStepRow } from "@/lib/kernel"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

// Onboarding steps are brokerage-wide templates — only admins/brokers
// should be able to create / update / delete them. Previously the gate
// was just auth.getUser() with no role check, so any agent could
// rewrite the onboarding flow for their entire brokerage.
async function getAuthenticatedAdminUserId(): Promise<{ userId: string; brokerageId: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")
  const { data: profile } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  const isAdmin = isAdminOrBroker({ user_type: profile?.user_type ?? "" })
  if (!isAdmin) throw new Error("Forbidden: brokerage admin only")
  // WAVE 155 (lane 155R19): the SESSION's tenant, for the receipt each change below leaves (the kernel resolves the same one for the row).
  return { userId: user.id, brokerageId: (profile as { brokerage_id?: string | null } | null)?.brokerage_id ?? "" }
}

export async function createBrokerageStep(
  input: {
    day_number: number
    step_order: number
    step_key: string
    step_name: string
    category: OnboardingStepRow["category"]
    required: boolean
    estimated_minutes?: number | null
    video_url?: string | null
    instructions?: string | null
  }
): Promise<{ id: string }> {
  const { userId, brokerageId } = await getAuthenticatedAdminUserId()
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const r = await ledgerSessionAction({ brokerageId, action: "onboarding.brokerage_step.create", actor: { type: "user", userId }, subject: { type: "onboarding_step" }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { step_key: input.step_key } }, async () => createOnboardingStepForBrokerage({ userId, step: input }))
  if (!("id" in r)) throw new Error(r.error ?? "The onboarding step was not recorded")
  return r
}

export async function updateBrokerageStep(
  stepId: string,
  updates: Partial<
    Pick<
      OnboardingStepRow,
      | "day_number"
      | "step_order"
      | "step_key"
      | "step_name"
      | "category"
      | "required"
      | "estimated_minutes"
      | "video_url"
      | "instructions"
    >
  >
): Promise<void> {
  const { userId, brokerageId } = await getAuthenticatedAdminUserId()
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const r = await ledgerSessionAction({ brokerageId, action: "onboarding.brokerage_step.update", actor: { type: "user", userId }, subject: { type: "onboarding_step", id: stepId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, async (): Promise<{ success: boolean; error?: string }> => { await updateOnboardingStepForBrokerage({ userId, stepId, updates }); return { success: true } })
  if (!r.success) throw new Error(r.error ?? "The onboarding step change was not recorded")
}

export async function deleteBrokerageStep(stepId: string): Promise<void> {
  const { userId, brokerageId } = await getAuthenticatedAdminUserId()
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const r = await ledgerSessionAction({ brokerageId, action: "onboarding.brokerage_step.delete", actor: { type: "user", userId }, subject: { type: "onboarding_step", id: stepId }, riskClass: "IRREVERSIBLE", reasonCode: "HUMAN_REQUESTED" }, async (): Promise<{ success: boolean; error?: string }> => { await deleteOnboardingStepForBrokerage({ userId, stepId }); return { success: true } })
  if (!r.success) throw new Error(r.error ?? "The onboarding step deletion was not recorded")
}
