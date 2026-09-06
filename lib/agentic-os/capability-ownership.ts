// lib/agentic-os/capability-ownership.ts
// ─────────────────────────────────────────────────────────────────────────────
// EVERY CAPABILITY HAS AN ACCOUNTABLE MANAGER.
//
// The capability contract answered "can this run?". It did not answer "and WHOSE
// job is it when it can't" — so a dark capability was a fact on a panel with
// nobody accountable for it. That is the gap the owner named: a feature added to
// this OS has to be MANAGED — ownership determined, collaboration real, and the
// loop closed decisively rather than left as a status light.
//
// So each app capability names the manager whose domain it serves, drawn from the
// SAME 14-seat registry that owns every table, cron and burn domain
// (lib/kernel/manager-registry.ts). Ownership follows the CHARTER, not the
// implementation: direct mail is a send, so the Campaign Orchestrator owns it even
// though the Lob credential is the Data Steward's to fix.
//
// The division of responsibility this encodes:
//
//   the OWNING manager   decides what to do about the capability being dark —
//                        route the touch to another channel, hold the play, tell
//                        the human it cannot be delivered
//   data_steward         owns CONNECTION integrity, so a missing platform
//                        credential escalates to the Steward, never to the manager
//                        who merely wanted to use it (a tenant cannot fix a
//                        platform key, and neither can the Campaign Orchestrator)
//   the self-healer      owns the technical repair, autonomously — if a healing
//                        proposal is already open, NOBODY is told, because there is
//                        no decision to make yet
//
// Pure — no I/O — so the map and the routing rule are unit-tested.

import type { ManagerKey } from "@/lib/kernel/manager-registry"
import { APP_CAPABILITY_REGISTRY, type AppCapability } from "./app-capability-registry"

/**
 * Capability → the manager accountable for it. Every key in
 * APP_CAPABILITY_REGISTRY must appear (the guard proves exhaustiveness, so a new
 * capability cannot ship unowned the way six features did).
 */
export const CAPABILITY_MANAGER: Record<AppCapability, ManagerKey> = {
  // ── Lead qualification & nurture — the ISA's charter ──
  lead_search:               "ai_isa",
  lead_create:               "ai_isa",
  isa_qualify:               "ai_isa",
  inbox_reply_send:          "ai_isa",

  // ── Data integrity, identity & connections — the Steward ──
  contact_get:               "data_steward",
  connectivity_scan:         "data_steward",

  // ── Sellers & listings — the Concierge ──
  cma_generate:              "listing_concierge",
  listing_publish:           "listing_concierge",

  // ── Buyer journey — the Shopping Agent ──
  appointment_schedule:      "shopping_agent",
  portal_milestones_get:     "shopping_agent",

  // ── Transactions & closings ──
  transaction_advance:       "deal_coordinator",

  // ── Multi-touch sends & sequences — the Orchestrator SENDS ──
  newsletter_send:           "campaign_orchestrator",
  marketing_campaign_create: "campaign_orchestrator",
  direct_mail_send:          "campaign_orchestrator",
  video_distribute:          "campaign_orchestrator",

  // ── Brand & promotion — the Marketing Manager ──
  blog_publish:              "marketing_agent",
  social_post_publish:       "marketing_agent",
  podcast_publish:           "marketing_agent",

  // ── Media & brand library — the Asset Manager ──
  content_repurpose:         "asset_manager",

  // ── Lifetime clients: repeat & referral — the Sphere Manager ──
  gift_send:                 "sphere_of_influence",
  handwritten_note_send:     "sphere_of_influence",
  review_request_send:       "sphere_of_influence",

  // ── Client education ──
  education_path_get:        "campaign_orchestrator",
  education_assign:         "campaign_orchestrator",

  // ── Money — the Finance Manager ──
  payment_transfer:          "finance_manager",
  accounting_sync:           "finance_manager",
  report_generate:           "finance_manager",
  report_export:             "finance_manager",
}

export function capabilityOwner(capability: AppCapability): ManagerKey {
  return CAPABILITY_MANAGER[capability]
}

/** What should HAPPEN about a dark capability, and who hears about it. */
export type DarkEscalation =
  /** A repair is already open — the healer owns it. Nobody is told; there is no
   *  decision to make until the repair lands or fails. */
  | { action: "hold_for_healer"; to: null; reason: string }
  /** The platform must configure a credential. Only the Steward can act. */
  | { action: "escalate_platform"; to: ManagerKey; reason: string }
  /** The tenant can connect it — the owning manager decides how to work around
   *  it in the meantime (another channel, hold the play, tell the human). */
  | { action: "notify_owner"; to: ManagerKey; reason: string }

/**
 * PURE: route a dark capability to whoever can actually do something about it.
 *
 * The ordering is the point. Healing first — telling a manager "direct mail is
 * down" while the healer is mid-repair produces a decision that is wrong by the
 * time it is made. Then the platform lane, because a manager cannot fix an env
 * key and should not be handed an action it has no power over. Only what is
 * genuinely actionable reaches the owning manager.
 */
export function routeDarkCapability(input: {
  capability: AppCapability
  reason: "no_connection" | "no_platform_credential" | "requirement_not_modelled" | null
  healingInFlight: boolean
  missing: readonly string[]
}): DarkEscalation {
  const owner = capabilityOwner(input.capability)
  const missing = input.missing.join(" / ") || "its provider"

  if (input.healingInFlight) {
    return {
      action: "hold_for_healer",
      to: null,
      reason: `${missing} is being repaired automatically — no manager decision needed yet.`,
    }
  }
  if (input.reason === "no_platform_credential") {
    return {
      action: "escalate_platform",
      to: "data_steward",
      reason: `${missing} is a platform-owned lane and is not configured. Only platform staff can light it; ${owner} cannot.`,
    }
  }
  if (input.reason === "requirement_not_modelled") {
    return {
      action: "escalate_platform",
      to: "data_steward",
      reason: `${input.capability} has no modelled dependency, so its readiness cannot be verified — a contract gap, not a tenant problem.`,
    }
  }
  return {
    action: "notify_owner",
    to: owner,
    reason: `${input.capability} cannot run until one of ${missing} is connected. ${owner} decides how to work around it until then.`,
  }
}

/** The signal type this loop publishes. Catalogued in lib/kernel/signal-registry. */
export const CAPABILITY_DARK_SIGNAL = "capability_dark" as const

/** PURE: the one-line brief a manager reads on the Command Center feed. */
export function darkCapabilityBrief(capability: AppCapability, e: DarkEscalation): string {
  const def = APP_CAPABILITY_REGISTRY[capability]
  return `${def.purpose} — unavailable. ${e.reason}`
}
