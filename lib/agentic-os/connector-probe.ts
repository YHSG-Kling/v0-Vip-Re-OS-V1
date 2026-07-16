// lib/agentic-os/connector-probe.ts
// The LIVE half of the adaptive connector agent. One spec-driven probe runner verifies any
// connector against its vendor health endpoint (no per-vendor switch — add a connector by
// adding a PROBE_SPEC, matching the /ecc:api-connector-builder "one pattern" rule). Each
// spec declares the health URL, the auth style, and the TOLERANT response shape; the runner
// fetches, adapts the response (connector-shape.adaptResponse → self-heals field renames),
// and the pure classifyProbe() turns the HTTP + drift signals into a status. Decisions are
// pure/testable; the fetch is real production code.

import {
  adaptResponse,
  type ConnectorShapeSpec,
  type ShapeDrift,
} from "./connector-shape"

export type ProbeStatus =
  | "ok"             // reachable, authed, shape healthy
  | "shape_drift"    // reachable + authed, but the response shape no longer matches
  | "auth_failed"    // 401/403/4xx — credential rejected
  | "unreachable"    // network error or 5xx
  | "not_configured" // no usable credential to probe with

export type AuthStyle =
  | "bearer_access_token" // Authorization: Bearer <accessToken>
  | "bearer_api_key"      // Authorization: Bearer <apiKey>
  | "basic_key_only"      // Authorization: Basic base64(apiKey:)   (Lob)
  | "basic_raw_key"       // Authorization: Basic <apiKey>          (D-ID, key is pre-encoded)
  | "header_xi_api_key"   // xi-api-key: <apiKey>                   (ElevenLabs)
  | "header_x_api_key"    // X-Api-Key: <apiKey>                    (RentCast)
  | "header_accesskey"    // accesskey: <apiKey>  (IDX Broker)
  | "query_access_token"  // ?access_token=<accessToken>  (Meta Graph)
  | "basic_sid_token"     // Authorization: Basic base64(apiKey:apiSecret)  (Twilio)

export interface ResolvedConn {
  apiKey?: string | null
  apiSecret?: string | null
  accessToken?: string | null
  config?: Record<string, unknown> | null
}

export interface ProbeSpec {
  provider: string
  /** Health/identity endpoint. A function form lets it interpolate config (e.g. QBO realmId). */
  url: string | ((conn: ResolvedConn) => string | null)
  auth: AuthStyle
  /** Tolerant expected shape of the health response — drift here flags a vendor change. */
  shape: ConnectorShapeSpec
}

/** Health-endpoint probes for the connectors with a known liveness call. Each shape lists
 *  the canonical identity fields + the aliases a vendor might rename them to. */
export const PROBE_SPECS: Record<string, ProbeSpec> = {
  idxbroker: {
    provider: "idxbroker",
    url: "https://api.idxbroker.com/clients/accountinfo",
    auth: "header_accesskey",
    shape: { connector: "idxbroker", fields: [{ canonical: "clientID", aliases: ["clientId", "id", "memberID"], required: false }] },
  },
  gohighlevel: {
    provider: "gohighlevel",
    url: "https://rest.gohighlevel.com/v1/contacts/",
    auth: "bearer_api_key",
    shape: { connector: "gohighlevel", fields: [{ canonical: "contacts", aliases: ["data", "results"], required: false }] },
  },
  meta: {
    provider: "meta",
    url: "https://graph.facebook.com/v18.0/me",
    auth: "query_access_token",
    shape: { connector: "meta", fields: [{ canonical: "id", aliases: ["user_id"], required: true }, { canonical: "name", aliases: ["full_name"], required: false }] },
  },
  sendgrid: {
    provider: "sendgrid",
    url: "https://api.sendgrid.com/v3/scopes",
    auth: "bearer_api_key",
    shape: { connector: "sendgrid", fields: [{ canonical: "scopes", aliases: ["permissions"], required: true }] },
  },
  twilio: {
    provider: "twilio",
    url: (conn) => (conn.apiKey ? `https://api.twilio.com/2010-04-01/Accounts/${conn.apiKey}.json` : null),
    auth: "basic_sid_token",
    shape: { connector: "twilio", fields: [{ canonical: "sid", aliases: ["account_sid"], required: true }, { canonical: "status", aliases: ["state"], required: false }] },
  },
  stripe: {
    provider: "stripe",
    url: "https://api.stripe.com/v1/account",
    auth: "bearer_access_token",
    shape: { connector: "stripe", fields: [{ canonical: "id", aliases: ["account_id"], required: true }, { canonical: "charges_enabled", aliases: ["chargesEnabled"], required: false }] },
  },
  quickbooks: {
    provider: "quickbooks",
    url: (conn) => {
      const realmId = conn.config?.realmId as string | undefined
      return realmId ? `https://quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}?minorversion=73` : null
    },
    auth: "bearer_access_token",
    shape: { connector: "quickbooks", fields: [{ canonical: "CompanyInfo", aliases: ["companyInfo", "company"], required: true }] },
  },
  // ── PLATFORM-KEYED PROVIDERS (Integration Guardian coverage audit) ─────────
  // These serve every tenant from platform env keys — probed once per guardian
  // run, failures ledgered platform-scoped. BatchData is intentionally absent:
  // its APIs are POST-only (no cheap liveness read) and its shape drift is
  // already watched by the pull-drift sentinel.
  lob: {
    provider: "lob",
    url: "https://api.lob.com/v1/addresses?limit=1",
    auth: "basic_key_only",
    shape: { connector: "lob", fields: [{ canonical: "data", aliases: ["addresses"], required: true }] },
  },
  elevenlabs: {
    provider: "elevenlabs",
    url: "https://api.elevenlabs.io/v1/user",
    auth: "header_xi_api_key",
    shape: { connector: "elevenlabs", fields: [{ canonical: "subscription", aliases: ["subscription_info", "plan"], required: true }] },
  },
  did: {
    provider: "did",
    url: "https://api.d-id.com/credits",
    auth: "basic_raw_key",
    shape: { connector: "did", fields: [{ canonical: "remaining", aliases: ["credits", "balance"], required: true }] },
  },
  rentcast: {
    provider: "rentcast",
    url: "https://api.rentcast.io/v1/markets?zipCode=78701",
    auth: "header_x_api_key",
    shape: { connector: "rentcast", fields: [{ canonical: "saleData", aliases: ["sale_data", "rentalData", "id"], required: false }] },
  },
}

/** The platform-keyed providers the guardian probes once per run (not per tenant),
 *  paired with the env var carrying the key. Exported so the guardian cron and the
 *  simulator share ONE list — a new platform provider is added here or CI can ask why. */
export const PLATFORM_PROVIDER_KEYS: Record<string, string> = {
  lob: "LOB_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  did: "DID_API_KEY",
  rentcast: "RENTCAST_API_KEY",
}

export interface ProbeResult {
  provider: string
  status: ProbeStatus
  httpStatus: number | null
  drifted: boolean
  drift: ShapeDrift | null
  checkedAt: string
  error: string | null
}

/** Pure: turn the HTTP + drift signals into a status. Order: configured → reachable →
 *  authed → shape. 4xx (except 429) reads as auth/permission; 5xx + 429 + network → unreachable. */
export function classifyProbe(input: {
  configured: boolean
  httpStatus: number | null
  networkError: boolean
  missingRequired: string[]
}): ProbeStatus {
  if (!input.configured) return "not_configured"
  if (input.networkError || input.httpStatus === null) return "unreachable"
  if (input.httpStatus >= 500 || input.httpStatus === 429) return "unreachable"
  if (input.httpStatus === 401 || input.httpStatus === 403) return "auth_failed"
  if (input.httpStatus >= 400) return "auth_failed"
  if (input.missingRequired.length > 0) return "shape_drift"
  return "ok"
}

function buildRequest(spec: ProbeSpec, conn: ResolvedConn): { url: string; headers: Record<string, string> } | null {
  const rawUrl = typeof spec.url === "function" ? spec.url(conn) : spec.url
  if (!rawUrl) return null
  let url = rawUrl
  const headers: Record<string, string> = { Accept: "application/json" }
  switch (spec.auth) {
    case "bearer_access_token":
      if (!conn.accessToken) return null
      headers.Authorization = `Bearer ${conn.accessToken}`
      break
    case "bearer_api_key":
      if (!conn.apiKey) return null
      headers.Authorization = `Bearer ${conn.apiKey}`
      break
    case "header_accesskey":
      if (!conn.apiKey) return null
      headers.accesskey = conn.apiKey
      break
    case "basic_key_only":
      if (!conn.apiKey) return null
      headers.Authorization = `Basic ${Buffer.from(`${conn.apiKey}:`).toString("base64")}`
      break
    case "basic_raw_key":
      if (!conn.apiKey) return null
      headers.Authorization = `Basic ${conn.apiKey}`
      break
    case "header_xi_api_key":
      if (!conn.apiKey) return null
      headers["xi-api-key"] = conn.apiKey
      break
    case "header_x_api_key":
      if (!conn.apiKey) return null
      headers["X-Api-Key"] = conn.apiKey
      break
    case "query_access_token": {
      if (!conn.accessToken) return null
      const u = new URL(url)
      u.searchParams.set("access_token", conn.accessToken)
      url = u.toString()
      break
    }
    case "basic_sid_token":
      if (!conn.apiKey || !conn.apiSecret) return null
      headers.Authorization = `Basic ${Buffer.from(`${conn.apiKey}:${conn.apiSecret}`).toString("base64")}`
      break
  }
  return { url, headers }
}

/**
 * Run a live health probe for a connector. Real fetch → adapt the response shape → classify.
 * Never throws: a thrown fetch becomes status "unreachable". Connectors with no PROBE_SPEC
 * return null (the caller falls back to credential-posture health, not a fabricated "ok").
 */
export async function probeConnector(provider: string, conn: ResolvedConn): Promise<ProbeResult | null> {
  const spec = PROBE_SPECS[provider]
  if (!spec) return null
  const checkedAt = new Date().toISOString()

  const req = buildRequest(spec, conn)
  if (!req) {
    return { provider, status: "not_configured", httpStatus: null, drifted: false, drift: null, checkedAt, error: "Missing credential fields for probe" }
  }

  let httpStatus: number | null = null
  let networkError = false
  let drift: ShapeDrift | null = null
  let error: string | null = null

  try {
    const res = await fetch(req.url, { headers: req.headers, signal: AbortSignal.timeout(10_000) })
    httpStatus = res.status
    if (res.ok) {
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      const adapted = adaptResponse(json, spec.shape)
      drift = adapted.drift
    } else {
      error = `HTTP ${res.status}`
    }
  } catch (err) {
    networkError = true
    error = err instanceof Error ? err.message : String(err)
  }

  const status = classifyProbe({
    configured: true,
    httpStatus,
    networkError,
    missingRequired: drift?.missingRequired ?? [],
  })
  return {
    provider,
    status,
    httpStatus,
    drifted: !!drift && (drift.aliased.length > 0 || drift.missingRequired.length > 0),
    drift,
    checkedAt,
    error: status === "ok" ? null : error,
  }
}
