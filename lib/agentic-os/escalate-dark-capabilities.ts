// lib/agentic-os/escalate-dark-capabilities.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE LOOP THAT CLOSES: A DARK CAPABILITY REACHES THE MANAGER WHO CAN ACT ON IT.
//
// The capability contract made readiness HONEST — the MCP tool list stopped
// vouching for capabilities it could not deliver, and a panel shows a broker what
// is held back. Both are still passive. A status light nobody is accountable for
// is not an agentic OS; it is a dashboard.
//
// So readiness now publishes onto the manager bus. Each dark capability routes to
// whoever can genuinely act (lib/agentic-os/capability-ownership.ts):
//
//   healing in flight        → NOBODY is told. The healer owns the repair, and a
//                              decision made mid-repair is wrong by the time it
//                              lands. Autonomy means letting the autonomous part
//                              finish, not narrating it.
//   platform credential      → the Data Steward, who owns connection integrity.
//                              Handing "Lob is down" to the Campaign Orchestrator
//                              gives an action to a manager with no power over it.
//   tenant connection        → the OWNING manager, which is the only one that can
//                              decide the workaround: route the touch to another
//                              channel, hold the play, or tell the human plainly.
//
// Deduped per (manager, signal, capability) by publishManagerSignal's own open-row
// check, so a capability that stays dark for a week produces ONE signal, not one
// per sweep. Never throws: a readiness sweep that cannot run must not take the
// cron down with it.
//
// Rides the EXISTING connector-health cron rather than adding a schedule — the
// Cron Manager owns loop health, and a second heartbeat for the same question is
// the drift this codebase keeps paying for.

import "server-only"
import { resolveAllAppCapabilities } from "./resolve-app-capability"
import {
  routeDarkCapability,
  darkCapabilityBrief,
  CAPABILITY_DARK_SIGNAL,
} from "./capability-ownership"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"

export interface DarkEscalationResult {
  brokerageId: string
  /** Capabilities resolved. */
  checked: number
  /** Dark capabilities found. */
  dark: number
  /** Signals actually published (deduped ones do not count twice). */
  escalated: number
  /** Held because the self-healer already has an open repair. */
  heldForHealer: number
  /** Per-capability outcome, for the cron's log line. */
  outcomes: Array<{ capability: string; action: string; to: string | null }>
  error: string | null
}

/**
 * Sweep one brokerage's capability readiness and escalate what is actionable.
 *
 * `fromManager` is the Data Steward: it owns connection integrity, so it is the
 * manager that OBSERVES a capability going dark and tells the others. A signal
 * must have two distinct registered managers (validSignalRoute), so a capability
 * the Steward itself owns is escalated by the Cron Manager instead — the operations
 * seat that owns loop health, and the honest sender when the observer would
 * otherwise be talking to itself.
 */
export async function escalateDarkCapabilities(
  brokerageId: string,
): Promise<DarkEscalationResult> {
  const result: DarkEscalationResult = {
    brokerageId, checked: 0, dark: 0, escalated: 0, heldForHealer: 0,
    outcomes: [], error: null,
  }
  try {
    const resolutions = await resolveAllAppCapabilities({ brokerageId })
    result.checked = resolutions.length

    for (const r of resolutions) {
      if (r.operable) continue
      result.dark++

      const route = routeDarkCapability({
        capability: r.capability,
        reason: r.reason,
        healingInFlight: r.healingInFlight,
        missing: r.missing,
      })

      if (route.action === "hold_for_healer") {
        result.heldForHealer++
        result.outcomes.push({ capability: r.capability, action: route.action, to: null })
        continue
      }

      // The observer. data_steward normally; cron_manager when the target IS the
      // steward, because a signal never routes a manager to itself.
      const fromManager = route.to === "data_steward" ? "cron_manager" : "data_steward"

      const published = await publishManagerSignal({
        brokerageId,
        fromManager,
        toManager: route.to,
        signalType: CAPABILITY_DARK_SIGNAL,
        message: darkCapabilityBrief(r.capability, route),
        entityType: "app_capability",
        // Dedupe key: one open signal per capability, however many sweeps run.
        entityId: r.capability,
        payload: {
          capability: r.capability,
          reason: r.reason,
          missing: r.missing,
          escalation: route.action,
          scope: r.def.scope,
          domain: r.def.domain,
        },
      })
      if (published.ok && published.reason !== "already open (deduped)") result.escalated++
      result.outcomes.push({ capability: r.capability, action: route.action, to: route.to })
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
  }
  return result
}
