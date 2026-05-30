/**
 * LIB/ORCHESTRATOR: EVENT TYPES — re-export shim.
 *
 * Canonical definitions have moved to lib/events/types.ts so that
 * lib/events/ has no upward dependency on lib/orchestrator/.
 *
 * This file is kept for backward compatibility with any existing importers.
 * Prefer importing directly from "@/lib/events/types".
 */
export type { EventInput, Event, OrchestratorEvent } from "@/lib/events"
export { EVENT_TYPES } from "@/lib/events"
