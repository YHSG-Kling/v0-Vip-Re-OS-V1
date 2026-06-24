// lib/listing-lifecycle/stage-automations.ts
//
// PURE: which CANONICAL lifecycle stage triggers which action-layer automation. Keyed on the canonical
// UPPERCASE stage names (lib/listing-lifecycle/lifecycle-definitions) — NOT the legacy lowercase
// vocabulary the dead triggerStageActions switch uses. Extracting + unit-testing this mapping guards
// against the exact case/name drift that silently left the stage automations not firing from the UI.

export type StageAutomation = "listing_appt_prep" | "mls_packet" | null

/**
 * Map a canonical listing stage to the automation the action layer fires for it.
 *  · APPOINTMENT_SET → the flagship pre-listing prep chain (CMA → presentation → chapter videos →
 *    pre-appointment drip → pre-listing postcard).
 *  · MLS_ACTIVE → queue the MLS listing packet.
 * Any other stage (or a wrong-cased legacy name) → null (no action-layer automation yet).
 */
export function stageAutomationFor(stage: string): StageAutomation {
  switch (stage) {
    case "APPOINTMENT_SET":
      return "listing_appt_prep"
    case "MLS_ACTIVE":
      return "mls_packet"
    default:
      return null
  }
}
