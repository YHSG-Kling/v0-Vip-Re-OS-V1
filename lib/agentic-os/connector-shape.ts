// lib/agentic-os/connector-shape.ts
// The ADAPTIVE half of the connector agent. Two concerns, both pure:
//
//  1. SHAPE INFERENCE — given a stored credential's fields, infer which transport it is
//     (api_key / oauth / mcp) and whether the shape is COMPLETE + REFRESHABLE for that
//     transport. This lets the agent recognize a "correct connection shape" without being
//     told the transport up front — and spot a half-configured connection (e.g. an OAuth
//     row missing its refresh token, which will silently die at first expiry).
//
//  2. RESPONSE ADAPTATION — vendors rename/move fields without warning. Instead of a brittle
//     exact-key parser, each connector declares its CANONICAL fields plus the ALIASES a vendor
//     might use. adaptResponse() resolves each canonical field through its aliases, returning
//     the normalized object AND a drift report (which fields had to fall back to an alias,
//     which required fields are missing, which keys are brand new). The product keeps working
//     through a rename (self-healing) while the drift report feeds a proactive alert.
//
// Pure — no I/O — so inference + adaptation are unit-tested deterministically against
// synthetic vendor payloads. The live probe that USES this lives in connector-probe.ts.

import type { Transport } from "./connectivity-agent"

// ─── 1. Shape inference ───────────────────────────────────────────────────────

export interface CredentialFields {
  apiKey?: string | null
  apiSecret?: string | null
  accessToken?: string | null
  refreshToken?: string | null
  tokenExpiresAt?: string | null
  /** An MCP server endpoint URL, when the connection is an MCP transport. */
  mcpUrl?: string | null
  /** Free-form config bag (e.g. IDX accesskey, account id, location id). */
  config?: Record<string, unknown> | null
}

export interface ShapeAssessment {
  transport: Transport
  /** The shape has the minimum fields required to actually make a call. */
  complete: boolean
  /** OAuth only: a refresh token is present, so the agent can renew before expiry. */
  refreshable: boolean
  /** Required fields that are absent for the inferred transport. */
  missing: string[]
}

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0

/** Pure: infer the transport from which credential fields are populated. MCP url wins
 *  (explicit endpoint), then OAuth tokens, then an api key/secret, else "api_key" (the
 *  most common default) — reported incomplete so the caller knows it is unconfigured. */
export function inferTransport(fields: CredentialFields): Transport {
  if (nonEmpty(fields.mcpUrl)) return "mcp"
  if (nonEmpty(fields.accessToken) || nonEmpty(fields.refreshToken) || nonEmpty(fields.tokenExpiresAt)) return "oauth"
  if (nonEmpty(fields.apiKey) || nonEmpty(fields.apiSecret)) return "api_key"
  return "api_key"
}

/** Pure: assess whether a credential is a COMPLETE, usable shape for its transport. */
export function assessShape(fields: CredentialFields, transportHint?: Transport): ShapeAssessment {
  const transport = transportHint ?? inferTransport(fields)
  const missing: string[] = []
  let refreshable = false

  switch (transport) {
    case "oauth":
      if (!nonEmpty(fields.accessToken)) missing.push("accessToken")
      refreshable = nonEmpty(fields.refreshToken)
      break
    case "api_key":
      if (!nonEmpty(fields.apiKey) && !nonEmpty(fields.apiSecret)) missing.push("apiKey")
      break
    case "mcp":
      if (!nonEmpty(fields.mcpUrl)) missing.push("mcpUrl")
      break
    case "platform_managed":
      break // platform holds the key — nothing for the brokerage to supply
  }
  return { transport, complete: missing.length === 0, refreshable, missing }
}

// ─── 2. Response adaptation (self-healing on vendor field drift) ───────────────

export interface ConnectorField {
  /** Our internal canonical field name. */
  canonical: string
  /** Vendor key variants to try, in order. The canonical name is always tried first. */
  aliases: string[]
  required: boolean
}

export interface ConnectorShapeSpec {
  connector: string
  fields: ConnectorField[]
}

export interface ShapeDrift {
  /** Canonical fields that resolved only via an alias (vendor renamed/moved the field). */
  aliased: Array<{ canonical: string; matchedKey: string }>
  /** Required canonical fields not found under any known key. */
  missingRequired: string[]
  /** Raw keys present in the payload that we don't map (candidate new vendor fields). */
  unmapped: string[]
}

export interface AdaptResult<T = Record<string, unknown>> {
  value: T
  drift: ShapeDrift
  /** True when the vendor's shape no longer matches ours cleanly (aliased or missing). */
  drifted: boolean
}

function lookup(raw: Record<string, unknown>, keys: string[]): { key: string; value: unknown } | null {
  for (const k of keys) {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== "") return { key: k, value: raw[k] }
  }
  return null
}

/**
 * Pure: normalize a vendor payload to our canonical shape, resolving each field through its
 * alias list and reporting drift. Self-healing — a renamed field still maps as long as the
 * new name is a known alias; an unknown rename surfaces as missingRequired + unmapped so the
 * monitor can alert and a human can add the alias. Never throws.
 */
export function adaptResponse(raw: Record<string, unknown>, spec: ConnectorShapeSpec): AdaptResult {
  const value: Record<string, unknown> = {}
  const drift: ShapeDrift = { aliased: [], missingRequired: [], unmapped: [] }
  const consumed = new Set<string>()

  for (const f of spec.fields) {
    const keys = [f.canonical, ...f.aliases]
    const hit = lookup(raw, keys)
    if (hit) {
      value[f.canonical] = hit.value
      consumed.add(hit.key)
      if (hit.key !== f.canonical) drift.aliased.push({ canonical: f.canonical, matchedKey: hit.key })
    } else if (f.required) {
      drift.missingRequired.push(f.canonical)
    }
  }
  for (const k of Object.keys(raw)) {
    if (!consumed.has(k)) drift.unmapped.push(k)
  }
  const drifted = drift.aliased.length > 0 || drift.missingRequired.length > 0
  return { value, drift, drifted }
}

/** Pure: a connection is HEALTHY-SHAPED when no required field is missing. Aliased-but-present
 *  is still healthy (we adapted) — it only warrants a proactive "vendor changed" notice. */
export function shapeHealthy(drift: ShapeDrift): boolean {
  return drift.missingRequired.length === 0
}
