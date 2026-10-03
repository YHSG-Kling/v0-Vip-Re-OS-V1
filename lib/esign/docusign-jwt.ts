/**
 * lib/esign/docusign-jwt.ts — the PURE half of the platform's DocuSign account (lane 89A).
 *
 * DocuSign's JWT Grant (developers.docusign.com/platform/auth/jwt): the integration signs a
 * RS256 JWT — iss = integration key, sub = the impersonated API user's GUID, aud = the OAuth host
 * (account.docusign.com / account-d.docusign.com, NO scheme), scope "signature impersonation" —
 * and exchanges it at POST https://{aud}/oauth/token for a bearer token (≤ 1 h). No SDK is
 * needed for that; Node's crypto signs RS256. This module builds and inspects the assertion and
 * reads the env shape; the token exchange (egress) lives in docusign-platform-account.ts.
 *
 * No I/O, no server-only marker — the proof exercises it with a throwaway RSA key.
 */

import { createSign } from "node:crypto"

export const DOCUSIGN_JWT_SCOPE = "signature impersonation"
const DOCUSIGN_JWT_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer"

/** The env the platform DocuSign account needs. Named here once; .env.example documents them. */
export const PLATFORM_DOCUSIGN_ENV = [
  "DOCUSIGN_INTEGRATION_KEY",
  "DOCUSIGN_JWT_USER_ID",
  "DOCUSIGN_RSA_PRIVATE_KEY",
  "DOCUSIGN_PLATFORM_ACCOUNT_ID",
] as const

export interface PlatformDocusignEnvStatus {
  configured: boolean
  /** The env names that are empty — named so the refusal says what to set. */
  missing: string[]
  oauthHost: string
  baseUri: string
}

/** PURE: the REST base URI that pairs with an OAuth host — demo ↔ demo, production ↔ production.
 *  Module-private: read through platformDocusignEnvStatus (its `baseUri`). */
function docusignBaseUriForOauthHost(oauthHost: string, explicitBaseUri?: string | null): string {
  if (explicitBaseUri && explicitBaseUri.trim()) return explicitBaseUri.trim().replace(/\/$/, "")
  return /account-d\./i.test(oauthHost) ? "https://demo.docusign.net" : "https://www.docusign.net"
}

/** PURE: is the platform DocuSign account configured, and which variables are missing? */
export function platformDocusignEnvStatus(env: Record<string, string | undefined>): PlatformDocusignEnvStatus {
  const missing = PLATFORM_DOCUSIGN_ENV.filter((k) => !(env[k] ?? "").trim())
  const oauthHost = (env.DOCUSIGN_OAUTH_HOST ?? "").trim() || "account.docusign.com"
  return { configured: missing.length === 0, missing, oauthHost, baseUri: docusignBaseUriForOauthHost(oauthHost, env.DOCUSIGN_BASE_URI) }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
}

/** PURE: an env value may carry the PEM with literal "\n" (Vercel / dotenv) — restore real newlines. */
export function normalizePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem
}

export interface DocusignJwtInput {
  integrationKey: string
  /** The impersonated API user's GUID (DOCUSIGN_JWT_USER_ID). */
  userId: string
  /** OAuth host WITHOUT a scheme (account.docusign.com / account-d.docusign.com). */
  oauthHost: string
  privateKeyPem: string
  /** Seconds since epoch; injectable so the proof can pin it. */
  nowSec?: number
  /** Lifetime in seconds — DocuSign caps the assertion at 1 hour. */
  ttlSec?: number
}

/** PURE: build the signed RS256 assertion DocuSign's JWT Grant exchanges for an access token. */
export function buildDocusignJwtAssertion(input: DocusignJwtInput): string {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000)
  const ttl = Math.min(Math.max(input.ttlSec ?? 3600, 60), 3600)
  const header = { typ: "JWT", alg: "RS256" }
  const claims = {
    iss: input.integrationKey,
    sub: input.userId,
    aud: input.oauthHost.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    iat: now,
    exp: now + ttl,
    scope: DOCUSIGN_JWT_SCOPE,
  }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  const signer = createSign("RSA-SHA256")
  signer.update(signingInput)
  const signature = signer.sign(normalizePem(input.privateKeyPem))
  return `${signingInput}.${b64url(signature)}`
}

/** PURE: the form body of the token exchange. */
export function docusignTokenExchangeBody(assertion: string): Record<string, string> {
  return { grant_type: DOCUSIGN_JWT_GRANT_TYPE, assertion }
}
