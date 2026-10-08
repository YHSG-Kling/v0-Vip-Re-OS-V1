// lib/integrations/integration-status.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE brokerage_integrations.status vocabulary.
//
// The live CHECK:
//
//   CHECK (status = ANY (ARRAY['connected','error','not_configured']))
//
// There is no 'active'. Three CRM/showing surfaces used it anyway:
//
//   app/actions/crm-connect.ts             upsert status: 'active'  … and eq('status','active')
//   lib/crm/sync.ts                        eq('status','active')
//   lib/workflow/adapters/schedule-showing.ts  eq('status','active')
//
// The write was rejected, so connecting a brokerage-level CRM stored the
// credential and then failed on the integration row — a half-connected state the
// UI reported as an error. The reads matched nothing, so the sync layer never
// resolved a brokerage-level provider, the CRM settings page always showed no
// active integration, and the showing adapter never found its ShowingTime API
// key and fell back to the manual path.
//
// The rest of the codebase already spelled it 'connected' — the OAuth callback
// writes it, and onboarding's tech-stack surface even had the right union typed
// inline. That union now comes from here.
//
// A FOURTH 'active' surface, found 2026-09-24 (lane 81E):
//
//   app/api/cron/health-check/route.ts   integration.status === "active"
//                                        ? "healthy" : "degraded"
//
// No row can hold 'active', so the platform health board scored EVERY
// brokerage integration it inspected as degraded. It reads through
// isIntegrationConnected now. The provider-test route
// (app/api/integrations/test/[provider]/route.ts) is the 'error' WRITER — it
// spelled both values as literals, which is how the vocabulary module came to
// record "no writer stamps 'error'" while one did.

/** Every value the CHECK admits. */
export const INTEGRATION_STATUSES = ["connected", "error", "not_configured"] as const

export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number]

/** Wired up and usable. The value 'active' was never one of these. */
export const INTEGRATION_STATUS_CONNECTED: IntegrationStatus = "connected"
/** Never configured, or deliberately disconnected. */
export const INTEGRATION_STATUS_NOT_CONFIGURED: IntegrationStatus = "not_configured"
/** Configured but failing — credentials rejected, provider unreachable.
 *  WRITER: app/api/integrations/test/[provider]/route.ts stamps it (with
 *  last_error) when a provider test fails — the health writer lane 80E's tag
 *  recorded as missing had been there all along, spelled as the literal
 *  "error" (lane 81E, 2026-09-24). The cron health board reads the row back
 *  through isIntegrationConnected below. */
export const INTEGRATION_STATUS_ERROR: IntegrationStatus = "error"

/** PURE — is this integration usable right now? */
export function isIntegrationConnected(status: string | null | undefined): boolean {
  return status === INTEGRATION_STATUS_CONNECTED
}
