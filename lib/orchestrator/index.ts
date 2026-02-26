// ─── WORKFLOW ENGINE ──────────────────────────────────────────────────────────
export { WorkflowOrchestrator, WORKFLOW_DEFINITIONS, triggerWorkflow } from "./workflow-engine"

// ─── EVENT TYPES (re-exported from lib/events for backwards compatibility) ────
// Prefer importing directly from "@/lib/events" for new code.
export type { EventInput, Event } from "./event-types"
export { EVENT_TYPES } from "./event-types"
