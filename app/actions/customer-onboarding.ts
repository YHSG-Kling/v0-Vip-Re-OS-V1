"use server"

/**
 * Sprint 10 — Customer onboarding server actions.
 *
 * Auth: the caller MUST own the contact (auth.uid() = contacts.user_id).
 * Anything else is rejected — customers can only advance their own journey.
 */

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  ensureCustomerOnboardingStarted,
  advanceCustomerOnboardingStep,
  dismissCustomerWelcome,
  resolveCustomerOnboardingState,
  type CustomerOnboardingState,
} from "@/lib/kernel/customer-onboarding"

async function requireContactOwnership(contactId: string): Promise<
  | { ok: true; userId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, user_id")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact) return { ok: false, error: "Contact not found" }
  if (contact.user_id !== user.id) return { ok: false, error: "Forbidden" }
  return { ok: true, userId: user.id }
}

export async function startCustomerOnboardingAction(
  contactId: string,
): Promise<{ ok: true; state: CustomerOnboardingState } | { ok: false; error: string }> {
  const auth = await requireContactOwnership(contactId)
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const state = await ensureCustomerOnboardingStarted(svc, contactId)
  if (!state) return { ok: false, error: "Could not start onboarding (missing brokerage on contact)" }

  revalidatePath(`/portal/${contactId}`)
  return { ok: true, state }
}

export async function advanceCustomerOnboardingStepAction(
  contactId: string,
  stepKey:   string,
): Promise<{ ok: true; state: CustomerOnboardingState } | { ok: false; error: string }> {
  const auth = await requireContactOwnership(contactId)
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const state = await advanceCustomerOnboardingStep(svc, contactId, stepKey)
  if (!state) return { ok: false, error: "No onboarding row to advance" }

  revalidatePath(`/portal/${contactId}`)
  return { ok: true, state }
}

export async function dismissCustomerWelcomeAction(
  contactId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireContactOwnership(contactId)
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const result = await dismissCustomerWelcome(svc, contactId)
  if (!result.ok) return { ok: false, error: "Could not dismiss welcome" }

  revalidatePath(`/portal/${contactId}`)
  return { ok: true }
}

export async function getCustomerOnboardingStateAction(
  contactId: string,
): Promise<{ ok: true; state: CustomerOnboardingState } | { ok: false; error: string }> {
  const auth = await requireContactOwnership(contactId)
  if (!auth.ok) return auth

  const supabase = await createClient()
  const state = await resolveCustomerOnboardingState(supabase, contactId)
  return { ok: true, state }
}
