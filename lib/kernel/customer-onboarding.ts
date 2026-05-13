/**
 * Sprint 10 — Customer onboarding journey kernel.
 *
 * Per-contact welcome / arrival state machine. Customers don't go through
 * agent_onboarding (that's for agent/tc/isa/team_lead); they get this
 * persona+portal-view-tailored walkthrough that finishes when they've
 * acknowledged their portal capabilities.
 *
 * Public API:
 *   ensureCustomerOnboardingStarted(contactId)
 *   advanceCustomerOnboardingStep(contactId, stepKey)
 *   dismissCustomerWelcome(contactId)
 *   resolveCustomerOnboardingState(contactId)
 *
 * Step vocabulary (open-ended; brokerage can extend):
 *   welcome              — first-touch hello
 *   meet_your_agent      — agent intro card
 *   tour_portal          — major sections walkthrough
 *   set_preferences      — communication channel + frequency
 *   first_lesson         — first learning module / education lesson
 *   complete             — terminal state
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

export const CUSTOMER_WELCOME_STEPS = [
  "welcome",
  "meet_your_agent",
  "tour_portal",
  "set_preferences",
  "first_lesson",
] as const

export type CustomerWelcomeStep = typeof CUSTOMER_WELCOME_STEPS[number]

export interface CustomerOnboardingState {
  exists:                boolean
  status:                "in_progress" | "completed" | "abandoned"
  currentStep:           CustomerWelcomeStep | "complete"
  completedSteps:        string[]
  completionPercentage:  number
  welcomeDismissedAt:    string | null
  startDate:             string
  contactPersona:        string | null
  portalView:            string | null
}

/**
 * Creates a customer_onboarding row for this contact if one doesn't exist.
 * Idempotent — the UNIQUE(contact_id) constraint protects against races.
 * Tenant-safe: pulls brokerage_id + persona + portal_view from the contact.
 */
export async function ensureCustomerOnboardingStarted(
  supabase:  SupabaseClient,
  contactId: string,
): Promise<CustomerOnboardingState | null> {
  // Already exists?
  const existing = await resolveCustomerOnboardingState(supabase, contactId)
  if (existing.exists) return existing

  // Need brokerage_id + persona from contact
  const { data: c } = await supabase
    .from("contacts")
    .select("brokerage_id, contact_persona")
    .eq("id", contactId)
    .maybeSingle()
  if (!c?.brokerage_id) return null

  // Best-effort portal view (used for the welcome arc copy)
  let portalView: string | null = null
  try {
    const { determinePortalView } = await import("@/lib/kernel/portal")
    const v = await determinePortalView(supabase, { contactId })
    portalView = v?.view ?? null
  } catch {
    // resolver may not be available in all contexts — leave null
  }

  const insert = {
    brokerage_id:           c.brokerage_id,
    contact_id:             contactId,
    contact_persona:        (c.contact_persona as string | null) ?? null,
    portal_view:            portalView,
    status:                 "in_progress",
    current_step:           "welcome",
    completed_steps:        [] as string[],
    completion_percentage:  0,
  }
  await supabase.from("customer_onboarding").upsert(insert, {
    onConflict: "contact_id",
    ignoreDuplicates: true,
  })

  return await resolveCustomerOnboardingState(supabase, contactId)
}

/**
 * Marks a step complete. If the step is the LAST one, transitions status
 * to 'completed' + sets completed_at. completion_percentage is recomputed
 * from completed_steps ∩ CUSTOMER_WELCOME_STEPS.
 */
export async function advanceCustomerOnboardingStep(
  supabase:  SupabaseClient,
  contactId: string,
  stepKey:   string,
): Promise<CustomerOnboardingState | null> {
  const { data: row } = await supabase
    .from("customer_onboarding")
    .select("id, completed_steps, status")
    .eq("contact_id", contactId)
    .maybeSingle()
  if (!row) return null
  if (row.status === "completed") return await resolveCustomerOnboardingState(supabase, contactId)

  const completed = new Set([...(row.completed_steps as string[] ?? []), stepKey])
  const eligible  = CUSTOMER_WELCOME_STEPS.filter(s => completed.has(s))
  const pct       = Math.round((eligible.length / CUSTOMER_WELCOME_STEPS.length) * 100)
  const allDone   = eligible.length === CUSTOMER_WELCOME_STEPS.length
  const nextStep  = allDone
    ? "complete"
    : (CUSTOMER_WELCOME_STEPS.find(s => !completed.has(s)) ?? "complete")

  const update: Record<string, unknown> = {
    completed_steps:       Array.from(completed),
    completion_percentage: pct,
    current_step:          nextStep,
    updated_at:            new Date().toISOString(),
  }
  if (allDone) {
    update.status       = "completed"
    update.completed_at = new Date().toISOString()
  }

  await supabase
    .from("customer_onboarding")
    .update(update)
    .eq("id", row.id)

  return await resolveCustomerOnboardingState(supabase, contactId)
}

/**
 * Customer clicks "Dismiss welcome". Sets welcome_dismissed_at — the panel
 * hides until next time but the journey stays in_progress so step
 * completion still counts toward the percentage.
 */
export async function dismissCustomerWelcome(
  supabase:  SupabaseClient,
  contactId: string,
): Promise<{ ok: boolean }> {
  const { error } = await supabase
    .from("customer_onboarding")
    .update({
      welcome_dismissed_at: new Date().toISOString(),
      updated_at:           new Date().toISOString(),
    })
    .eq("contact_id", contactId)
  return { ok: !error }
}

export async function resolveCustomerOnboardingState(
  supabase:  SupabaseClient,
  contactId: string,
): Promise<CustomerOnboardingState> {
  const { data } = await supabase
    .from("customer_onboarding")
    .select("status, current_step, completed_steps, completion_percentage, welcome_dismissed_at, start_date, contact_persona, portal_view")
    .eq("contact_id", contactId)
    .maybeSingle()
  if (!data) {
    return {
      exists:               false,
      status:               "in_progress",
      currentStep:          "welcome",
      completedSteps:       [],
      completionPercentage: 0,
      welcomeDismissedAt:   null,
      startDate:            new Date().toISOString().slice(0, 10),
      contactPersona:       null,
      portalView:           null,
    }
  }
  const r = data as Record<string, unknown>
  return {
    exists:               true,
    status:               r.status as "in_progress" | "completed" | "abandoned",
    currentStep:          (r.current_step as CustomerWelcomeStep | "complete"),
    completedSteps:       (r.completed_steps as string[] | null) ?? [],
    completionPercentage: (r.completion_percentage as number | null) ?? 0,
    welcomeDismissedAt:   (r.welcome_dismissed_at as string | null) ?? null,
    startDate:            r.start_date as string,
    contactPersona:       (r.contact_persona as string | null) ?? null,
    portalView:           (r.portal_view as string | null) ?? null,
  }
}
