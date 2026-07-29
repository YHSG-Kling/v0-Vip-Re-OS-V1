// lib/lead-assignment/solo-agent.ts
// ─────────────────────────────────────────────────────────────────────────────
// A SOLO TENANT GETS EVERYTHING. No exceptions, no ingress path excluded.
//
// The owner's rule: on a solo_agent subscription, every lead and every contact
// belongs to that one agent — whether it arrives from their own website, another
// real-estate site, a lead magnet or form they built, a CSV import, a QR scan, a
// scraped territory or a phone call.
//
// The CONTACT side honoured this (resolveAgentForContact step 2, ahead of rules).
// The LEAD side did not: evaluateAndAssignLead went straight to assignment_rules
// and then to the brokerage default. For a solo tenant that is wrong in three
// ways, and the third is new:
//
//   1. Any rule whose pool is not the solo agent could route the lead elsewhere —
//      to a stale agents row, an assistant, a departed licensee.
//   2. The capacity fallback compares "working load" across whatever active
//      agents rows exist, which is meaningless when the business has one agent.
//   3. Since m305 an admin can set the default method to 'manual'. On a solo
//      tenant that would HOLD the lead for a person to place — and the only
//      person is the agent it should already have gone to. Their own leads would
//      pile up unassigned.
//
// One resolver, called FIRST by both engines. The guarantee lives in one place,
// so a new ingress path inherits it by construction instead of having to
// remember it.

import type { createServiceClient } from "@/lib/supabase/service"
import { resolvePlanTier } from "@/lib/billing/plan-tier"

/**
 * The single agent who owns everything on a solo_agent brokerage, or null when
 * the brokerage is not solo (or has no active agent yet, mid-provisioning).
 *
 * Tier comes from resolvePlanTier — `plan_tier`, the column with writers. Reading
 * the unwritten `subscription_tier` twin here would have been the worst possible
 * place for that drift: a live tenant carried plan_tier='solo_agent' with
 * subscription_tier='brokerage', so a reader preferring the twin would decide a
 * solo agent's leads should be spread across a brokerage that does not exist.
 */
export async function resolveSoloAgentOwner(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
): Promise<string | null> {
  const tier = await resolvePlanTier(supabase, brokerageId)
  if (tier !== "solo_agent") return null

  // Oldest active agent — the founder's own row. Deterministic, and stable if a
  // second row is ever added (an assistant, a re-provisioned row), so ownership
  // never silently migrates between them.
  const { data } = await supabase
    .from("agents")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  return (data as { id?: string } | null)?.id ?? null
}
