/**
 * Sprint 10 — Customer onboarding journey kernel (journey-type aware).
 *
 * Per-contact welcome / arrival state machine. Customers don't go through
 * agent_onboarding (that's for agent/tc/isa/team_lead); they get this
 * persona+portal-view-tailored walkthrough.
 *
 * Four distinct journeys:
 *
 *   BUYER     — welcome → meet_your_agent → tour_portal → set_preferences
 *               → first_lesson
 *   SELLER    — welcome → meet_your_agent → upload_property_details
 *               → review_pricing_strategy → market_prep_checklist
 *               → first_lesson
 *   FOREVER   — welcome_back → review_home_value → set_refi_alerts
 *               → connect_anniversaries → vendor_marketplace_tour
 *   LIFETIME  — welcome_back → revisit_preferences → reconnect_with_agent
 *               → vendor_marketplace_tour
 *
 * Public API:
 *   ensureCustomerOnboardingStarted(contactId)
 *   advanceCustomerOnboardingStep(contactId, stepKey)
 *   dismissCustomerWelcome(contactId)
 *   resolveCustomerOnboardingState(contactId)
 *   resolveJourneyType(persona, portalView) — exposed for the welcome panel
 *
 * Step keys are stable strings; brokerages can extend the vocabulary by
 * writing their own steps into completed_steps without breaking the
 * percentage math (only steps in STEPS_BY_JOURNEY count toward 100%).
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

export type JourneyType = "buyer" | "seller" | "forever" | "lifetime"

export const STEPS_BY_JOURNEY: Record<JourneyType, readonly string[]> = {
  buyer:    ["welcome", "meet_your_agent", "tour_portal", "set_preferences", "first_lesson"] as const,
  seller:   ["welcome", "meet_your_agent", "upload_property_details", "review_pricing_strategy", "market_prep_checklist", "first_lesson"] as const,
  forever:  ["welcome_back", "review_home_value", "set_refi_alerts", "connect_anniversaries", "vendor_marketplace_tour"] as const,
  lifetime: ["welcome_back", "revisit_preferences", "reconnect_with_agent", "vendor_marketplace_tour"] as const,
}

export interface CustomerOnboardingState {
  exists:                boolean
  journeyType:           JourneyType
  status:                "in_progress" | "completed" | "abandoned"
  currentStep:           string
  completedSteps:        string[]
  completionPercentage:  number
  welcomeDismissedAt:    string | null
  startDate:             string
  contactPersona:        string | null
  portalView:            string | null
}

/**
 * Infer the customer's journey type from their persona and portal view.
 * Priority: portal_view ('forever' / 'lifetime' / 'deal' / 'match') overrides,
 * then seller-side personas fall to 'seller', everything else 'buyer'.
 */
export function resolveJourneyType(
  persona:    string | null | undefined,
  portalView: string | null | undefined,
): JourneyType {
  if (portalView === "forever")  return "forever"
  if (portalView === "lifetime") return "lifetime"
  const sellerPersonas = new Set([
    "expired", "fsbo", "divorce", "estate", "downsize_seller", "luxury_seller", "seller",
  ])
  if (persona && sellerPersonas.has(persona)) return "seller"
  return "buyer"
}

/**
 * Creates a customer_onboarding row for this contact if one doesn't exist.
 * Idempotent — UNIQUE(contact_id) protects against races. Resolves
 * journey_type at start so subsequent step advances use the right vocab.
 */
export async function ensureCustomerOnboardingStarted(
  supabase:  SupabaseClient,
  contactId: string,
): Promise<CustomerOnboardingState | null> {
  const existing = await resolveCustomerOnboardingState(supabase, contactId)
  if (existing.exists) return existing

  const { data: c } = await supabase
    .from("contacts")
    .select("brokerage_id, contact_persona")
    .eq("id", contactId)
    .maybeSingle()
  if (!c?.brokerage_id) return null

  // Best-effort portal view (used for the welcome arc copy AND journey type)
  let portalView: string | null = null
  try {
    const { determinePortalView } = await import("@/lib/kernel/portal")
    const v = await determinePortalView(supabase, { contactId })
    portalView = v?.view ?? null
  } catch {
    // resolver may not be available in all contexts
  }

  const journeyType = resolveJourneyType(c.contact_persona as string | null, portalView)
  const firstStep   = STEPS_BY_JOURNEY[journeyType][0] ?? "welcome"

  await supabase.from("customer_onboarding").upsert({
    brokerage_id:          c.brokerage_id,
    contact_id:            contactId,
    contact_persona:       (c.contact_persona as string | null) ?? null,
    portal_view:           portalView,
    journey_type:          journeyType,
    status:                "in_progress",
    current_step:          firstStep,
    completed_steps:       [] as string[],
    completion_percentage: 0,
  }, {
    onConflict:       "contact_id",
    ignoreDuplicates: true,
  })

  return await resolveCustomerOnboardingState(supabase, contactId)
}

/**
 * Marks a step complete. Percentage is computed against the journey's own
 * step list — extra ad-hoc steps don't dilute the score. When all steps in
 * the journey are complete, status flips to 'completed'.
 */
export async function advanceCustomerOnboardingStep(
  supabase:  SupabaseClient,
  contactId: string,
  stepKey:   string,
): Promise<CustomerOnboardingState | null> {
  const { data: row } = await supabase
    .from("customer_onboarding")
    .select("id, completed_steps, status, journey_type")
    .eq("contact_id", contactId)
    .maybeSingle()
  if (!row) return null
  if (row.status === "completed") return await resolveCustomerOnboardingState(supabase, contactId)

  const journeyType = (row.journey_type as JourneyType) ?? "buyer"
  const journeySteps = STEPS_BY_JOURNEY[journeyType]
  const completed = new Set([...(row.completed_steps as string[] ?? []), stepKey])
  const eligibleDone = journeySteps.filter(s => completed.has(s))
  const pct = Math.round((eligibleDone.length / journeySteps.length) * 100)
  const allDone = eligibleDone.length === journeySteps.length
  const nextStep = allDone
    ? "complete"
    : (journeySteps.find(s => !completed.has(s)) ?? "complete")

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
 * Customer dismisses the welcome panel. Journey stays in_progress so step
 * completion still counts; the panel just stops auto-rendering.
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
    .select("status, current_step, completed_steps, completion_percentage, welcome_dismissed_at, start_date, contact_persona, portal_view, journey_type")
    .eq("contact_id", contactId)
    .maybeSingle()
  if (!data) {
    return {
      exists:               false,
      journeyType:          "buyer",
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
    journeyType:          (r.journey_type as JourneyType) ?? "buyer",
    status:               r.status as "in_progress" | "completed" | "abandoned",
    currentStep:          r.current_step as string,
    completedSteps:       (r.completed_steps as string[] | null) ?? [],
    completionPercentage: (r.completion_percentage as number | null) ?? 0,
    welcomeDismissedAt:   (r.welcome_dismissed_at as string | null) ?? null,
    startDate:            r.start_date as string,
    contactPersona:       (r.contact_persona as string | null) ?? null,
    portalView:           (r.portal_view as string | null) ?? null,
  }
}
