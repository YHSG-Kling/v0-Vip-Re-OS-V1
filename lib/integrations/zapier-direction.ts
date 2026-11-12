// lib/integrations/zapier-direction.ts
// ─────────────────────────────────────────────────────────────────────────────
// ZAPIER IS OUTBOUND-ONLY (wave 87, lane 87A). Owner, verbatim:
//   "zapier zaps are only allowed out from this platform, never to the platform."
//
// OUT (kept — the survivor): a tenant pastes a Zap's "Catch Hook" URL as an
// outbound webhook subscription on /settings/developers; the platform POSTs
// signed events to it — lib/platform/tenant-webhooks.ts
// (enqueueTenantWebhookDeliveries → drainTenantWebhookDeliveries → postSignedWebhook).
//
// IN (retired): app/api/webhooks/zapier/route.ts — the inbound Zap action endpoint
// (HMAC over ZAPIER_WEBHOOK_SECRET + lane 86F's x-zapier-api-key tenant lookup on
// global_settings.zapier_api_key, writing lifecycle_events) is DELETED; its tombstone
// is in lib/providers/webhook-contract.ts where its contract row stood.
//
// The generic ingress doors a Zap could still be pointed at — the workflow trigger
// fabric (app/api/workflow/trigger) and the Agentic API bearer tokens
// (lib/agentic-os/agent-credentials.ts resolveAgenticCaller) — refuse a request
// that identifies itself as Zapier. Zapier's outbound HTTP identifies itself in
// User-Agent ("Zapier"; Zapier help "Mastering Zapier webhooks" / platform-core
// request client); a caller may also label itself with a `source` of "zapier".
// BLIND SPOT (stated, §2): a Zap that overrides its User-Agent AND omits the
// label is indistinguishable from any other HTTP client — this is the direction
// rule enforced where the request says who it is, not a fingerprint.

/** PURE — does this inbound request identify itself as a Zap? */
export function isZapierInbound(req: { userAgent: string | null | undefined; source?: string | null }): boolean {
  const ua = (req.userAgent ?? "").toLowerCase()
  const src = (req.source ?? "").trim().toLowerCase()
  return ua.includes("zapier") || src === "zapier" || src.startsWith("zapier_") || src.startsWith("zapier-")
}

/** The refusal sentence every ingress door returns — one wording (§6). */
export const ZAPIER_INBOUND_REFUSAL =
  "Zapier is outbound-only on this platform: connect a Zap by adding its Catch Hook URL as an outbound webhook in Settings → Developers."
