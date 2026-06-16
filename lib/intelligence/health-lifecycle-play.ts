// lib/intelligence/health-lifecycle-play.ts
//
// HEALTH-TRIGGERED LIFECYCLE PLAYS (pure). The relationship-health score shouldn't just sit on a
// dashboard — when a relationship DECAYS to at-risk/dormant, the right manager should be handed the
// right re-engagement play automatically, matched to who the person IS (a slipping past client is
// the Sphere manager's warm check-in; a stalling buyer is the Shopping Agent's job; a quiet seller
// is the Listing Concierge's). Healthy/cooling relationships need no intervention (the cadence has
// them). Turns the health score into ACTION. Pure (no I/O), unit-tested directly.

import type { HealthBand } from "./relationship-health"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

export interface LifecyclePlay {
  /** the play to run, or null when no intervention is warranted. */
  play: string | null
  manager: ManagerKey | null
  urgency: "none" | "soon" | "now"
  reason: string
}

function managerForType(contactType: string | null | undefined): ManagerKey {
  const t = (contactType ?? "").toLowerCase()
  if (/past|closed|sphere|repeat/.test(t)) return "sphere_of_influence"
  if (t === "seller" || t === "listing") return "listing_concierge"
  if (t === "buyer" || t === "both" || t === "investor") return "shopping_agent"
  return "ai_isa" // unconverted lead / unknown
}

/** Decide the lifecycle play (and owning manager) for a decaying relationship. Pure. */
export function lifecyclePlayForHealth(band: HealthBand, contactType: string | null | undefined): LifecyclePlay {
  if (band === "thriving" || band === "warm" || band === "cooling") {
    return { play: null, manager: null, urgency: "none", reason: `${band} — the cadence has this; no special play` }
  }
  const manager = managerForType(contactType)
  const urgency = band === "dormant" ? "now" : "soon"
  // play name reflects WHO they are + how far gone they are.
  const base = manager === "sphere_of_influence" ? "sphere_winback"
    : manager === "listing_concierge" ? "seller_reengage"
    : manager === "shopping_agent" ? "buyer_reengage"
    : "lead_reengage"
  const play = band === "dormant" ? `${base}_last_attempt` : base
  return { play, manager, urgency, reason: `relationship decayed to ${band} — hand ${manager} the ${play} play` }
}
