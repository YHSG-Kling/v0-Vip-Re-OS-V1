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

async function getAuthenticatedUserId(): Promise<string> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")
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
  const userId = await getAuthenticatedUserId()
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
  const userId = await getAuthenticatedUserId()
  return updateOnboardingStepForBrokerage({ userId, stepId, updates })
}

export async function deleteBrokerageStep(stepId: string): Promise<void> {
  const userId = await getAuthenticatedUserId()
  return deleteOnboardingStepForBrokerage({ userId, stepId })
}
