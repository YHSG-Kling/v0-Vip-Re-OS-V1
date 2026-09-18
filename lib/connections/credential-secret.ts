// lib/connections/credential-secret.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE READING OF "the second half of an API-key pair" out of a credential
// row's `config` blob.
//
// WHY THIS FILE EXISTS (wave 14, class 1b — a column read as a fact nothing
// writes). `agent_api_credentials.api_secret` and `integration_credentials.api_secret`
// were read at lib/integrations/connection-manager.ts and app/actions/dispatch-showing.ts
// and written by NOBODY, so every consumer of a key+SECRET provider got
// `apiSecret: null` and could never authenticate. Vibe CTV
// (lib/providers/vibe.ts:56 isVibeConfigured, :213 dispatchCtvCampaign) needs a
// client_id + client_secret pair; the Twilio probe
// (lib/agentic-os/connector-probe.ts:247) needs SID + auth token.
//
// The secret was NOT missing from the product. It was in a DIFFERENT SHAPE:
// `platform_credentials.config.auth_token`, written by the Connection Center
// (app/actions/connections/connection-center.ts:215 connectApiKeyProvider via
// lib/connections/field-spec.ts:156 — the `phone` domain collects `authToken`)
// and by app/actions/phone-connect.ts:33 connectPhoneAction. Two readers already
// knew that:
//
//   lib/providers/messaging/resolve-sms-provider.ts:69   cfg.auth_token
//   app/api/cron/connector-health/route.ts:110           cfg.auth_token ?? cfg.api_secret
//
// …and connection-manager did not: its platform_credentials tier hard-coded
// `apiSecret: null`, DISCARDING a secret that was sitting right there in the row
// it had just read. That is the defect: not an absent writer, an unread one.
//
// So the config-key vocabulary is stated ONCE, here, instead of a third and
// fourth time at each reader. Per CLAUDE.md §6: two spellings of the same idea
// are a defect, and this idea already had three.
//
// PURE and dependency-free — a cron (service role), a server action and a
// resolver all share it without importing each other's client.

/**
 * Every key a credential `config` blob may carry the pair's SECRET half under.
 *
 * ORDER IS THE RULING, not a preference:
 *   auth_token    what field-spec `phone` writes and resolve-sms-provider reads —
 *                 the only one any live writer produces today, so it wins.
 *   api_secret    the name the discrete COLUMN uses on the two legacy stores;
 *                 accepted here so a row hand-seeded in that vocabulary resolves.
 *   client_secret OAuth2 client-credentials naming (Vibe's own docs) — accepted
 *                 so a broker who pastes it under the provider's own word is not
 *                 silently unauthenticated.
 *   api_password  the Bandwidth spelling resolve-sms-provider already accepts.
 *
 * Deliberately CLOSED. A config blob is caller-supplied; scanning it for
 * anything that "looks like" a secret would make an arbitrary user-typed key
 * into a credential.
 */
export const CONFIG_SECRET_KEYS = ["auth_token", "api_secret", "client_secret", "api_password"] as const

/**
 * The secret half of an api-key pair, out of a credential row's config blob.
 * Returns null when the blob carries none — which is a real answer: a provider
 * authenticated by a single key has no second half, and inventing one would make
 * `isVibeConfigured` claim a pair that cannot sign a request.
 *
 * Empty strings are NOT secrets. A form that posted a blank box writes `""`, and
 * `"" ` passed to `Basic base64(id:"")` produces a request that fails at the
 * provider with an opaque 401 rather than an honest "not connected" here.
 */
export function secretFromConfig(config: unknown): string | null {
  if (!config || typeof config !== "object") return null
  const blob = config as Record<string, unknown>
  for (const key of CONFIG_SECRET_KEYS) {
    const v = blob[key]
    if (typeof v === "string" && v.trim() !== "") return v
  }
  return null
}
