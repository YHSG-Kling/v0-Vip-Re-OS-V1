/**
 * lib/esign/docusign-platform-account.ts — THE PLATFORM'S OWN DOCUSIGN ACCOUNT (lane 89A).
 *
 * Owner (wave 89): "the platforms defualt esign is no longer google but we decided on docusign
 * instead since it will embed in our platform window." The default must work for a tenant that has
 * connected NOTHING, so the platform holds one DocuSign account (an ISV integration key + an
 * impersonated API user, JWT Grant) and every unconfigured tenant's envelope is carried by it — the
 * agent still picks the contact, places the signature fields and presses Send inside OUR window
 * through DocuSign's embedded sender view (viewAccess "envelope" scopes that one-time URL to the
 * one envelope, so the platform's account is never exposed).
 *
 * PRECEDENCE (lib/integrations/resolve-esign-provider.ts): a tenant's own DocuSign credential
 * (agent → team → brokerage → platform_credentials owner_type 'platform') is tried FIRST; this env
 * account is the last rung, and only for the DEFAULT provider — never for a tenant that SELECTED
 * another vendor.
 *
 * COST: the platform pays per envelope on its developer/API plan (DocuSign developer plans are
 * priced on API envelope volume — ecom.docusign.com/plans-and-pricing/developer). That is the
 * owner's ruling; lane notes carry the number.
 *
 * Tokens are minted through the connector gateway (form-encoded, no SDK) and cached in-process
 * until a minute before expiry. Refusals are returned as values, never thrown.
 */

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import {
  buildDocusignJwtAssertion, docusignTokenExchangeBody, platformDocusignEnvStatus, normalizePem,
} from "@/lib/esign/docusign-jwt"

export interface PlatformDocusignCredential {
  /** The bearer token (the DocusignProvider's `apiKey`). */
  apiKey: string
  /** The platform DocuSign account id (the DocusignProvider's `profileId`). */
  profileId: string
  baseUri: string
  expiresAt: number
}

export type PlatformDocusignResolution =
  | { ok: true; credential: PlatformDocusignCredential }
  | { ok: false; configured: boolean; error: string }

let cached: PlatformDocusignCredential | null = null

/**
 * Mint (or reuse) the platform DocuSign bearer token. `ok:false` names the missing env when the
 * account is not configured, or DocuSign's refusal (a consent not yet granted for the impersonated
 * user is the common one: the API user must grant "signature impersonation" once).
 */
export async function resolvePlatformDocusignCredential(): Promise<PlatformDocusignResolution> {
  const env = process.env as Record<string, string | undefined>
  const status = platformDocusignEnvStatus(env)
  if (!status.configured) {
    return { ok: false, configured: false, error: `The platform DocuSign account is not configured (missing ${status.missing.join(", ")}).` }
  }
  if (cached && cached.expiresAt - 60_000 > Date.now()) return { ok: true, credential: cached }

  let assertion: string
  try {
    assertion = buildDocusignJwtAssertion({
      integrationKey: env.DOCUSIGN_INTEGRATION_KEY as string,
      userId: env.DOCUSIGN_JWT_USER_ID as string,
      oauthHost: status.oauthHost,
      privateKeyPem: normalizePem(env.DOCUSIGN_RSA_PRIVATE_KEY as string),
    })
  } catch (err) {
    return { ok: false, configured: true, error: `The platform DocuSign RSA key could not sign the JWT assertion: ${err instanceof Error ? err.message : String(err)}` }
  }

  const res = await callConnector<{ access_token?: string; expires_in?: number; error?: string; error_description?: string }>({
    connector: "docusign-oauth",
    baseUrl: `https://${status.oauthHost}`,
    path: "/oauth/token",
    method: "POST",
    bodyType: "form",
    body: docusignTokenExchangeBody(assertion),
    auth: { style: "none" },
    timeoutMs: 20_000,
  })
  if (!res.ok || !res.data?.access_token) {
    const detail = res.data?.error_description ?? res.data?.error ?? res.error ?? `HTTP ${res.status}`
    return { ok: false, configured: true, error: `DocuSign refused the platform account's JWT grant: ${detail}` }
  }
  cached = {
    apiKey: res.data.access_token,
    profileId: env.DOCUSIGN_PLATFORM_ACCOUNT_ID as string,
    baseUri: status.baseUri,
    expiresAt: Date.now() + Math.max(60, res.data.expires_in ?? 3600) * 1000,
  }
  return { ok: true, credential: cached }
}
