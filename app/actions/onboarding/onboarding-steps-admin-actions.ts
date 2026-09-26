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
async function getAuthenticatedAdminUserId(): Promise<string> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")
  const { data: profile } = await supabase
    .from("users").select("user_type").eq("id", user.id).maybeSingle()
  const isAdmin = isAdminOrBroker({ user_type: profile?.user_type ?? "" })
  if (!isAdmin) throw new Error("Forbidden: brokerage admin only")
  return user.id
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
  const userId = await getAuthenticatedAdminUserId()
  return createOnboardingStepForBrokerage({ userId, step: input })
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
  const userId = await getAuthenticatedAdminUserId()
  return updateOnboardingStepForBrokerage({ userId, stepId, updates })
}

export async function deleteBrokerageStep(stepId: string): Promise<void> {
  const userId = await getAuthenticatedAdminUserId()
  return deleteOnboardingStepForBrokerage({ userId, stepId })
}
