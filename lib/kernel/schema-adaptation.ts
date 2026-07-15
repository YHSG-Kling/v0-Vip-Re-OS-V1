// lib/kernel/schema-adaptation.ts
//
// THE SCHEMA ADAPTATION LAYER (cron_manager) — owner's Continuity Engine
// directive: "self heal when data is given to the OS from an external API but
// the code is expecting a different data structure." External payloads are
// translated into the canonical internal shape BEFORE the rest of the OS
// touches them, in the deterministic-core-first order the resilience
// literature prescribes:
//
//   1. DIRECT      — the expected path holds the value.
//   2. ALIAS       — a known rename / nesting change (each connector contract
//                    carries its alias dictionary, incl. dot-paths).
//   3. COERCION    — safe type drift only: "450000" → 450000, "true" → true,
//                    42 → "42". NEVER lossy, NEVER cross-meaning.
//   4. DEFAULT     — a missing OPTIONAL field takes its declared default.
//   5. EXTENSION   — unknown extra fields are CAPTURED (never dropped, never
//                    trusted) in an extension payload.
//   6. QUARANTINE  — a missing REQUIRED field stops propagation: the record
//                    parks for review instead of corrupting downstream state.
//
// Every adaptation is a receipt: which fields healed, how, and whether the
// payload may proceed. Repairs beyond DIRECT are genuine self-heals (the
// provider drifted; the OS absorbed it) and land on the self-heal ledger.
// AMBIGUITY IS QUARANTINE, never a guess: if two source fields could claim
// one target, the FIRST declared path wins deterministically and the rest
// stay in extensions — contracts order their paths by intent.

export type CanonicalType = "string" | "number" | "boolean"

export interface ContractField {
  /** canonical key downstream code expects */
  key: string
  type: CanonicalType
  required: boolean
  /** where the value may live, in priority order; dot-paths allowed ("client.contact.email") */
  paths: string[]
  /** default for a missing OPTIONAL field (never applied to required fields) */
  defaultValue?: string | number | boolean | null
}

export interface ConnectorContract {
  connector: string
  entity: string
  fields: ContractField[]
}

export type RepairKind = "direct" | "alias" | "coerced" | "defaulted"

export interface FieldRepair { key: string; kind: RepairKind; from?: string }

export interface AdaptedPayload {
  ok: boolean
  /** canonical record (only when ok) */
  canonical: Record<string, string | number | boolean | null>
  repairs: FieldRepair[]
  /** required fields that could not be resolved (non-empty ⇒ quarantine) */
  missingRequired: string[]
  /** unrecognized inbound fields, captured not dropped */
  extensions: Record<string, unknown>
  /** count of repairs beyond direct — the "the provider drifted" signal */
  driftRepairs: number
}

function readPath(raw: any, path: string): unknown {
  let cur = raw
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = cur[seg]
  }
  return cur
}

/** PURE: safe coercion only — returns undefined when conversion would guess. */
export function coerceValue(value: unknown, type: CanonicalType): string | number | boolean | undefined {
  if (value == null) return undefined
  if (type === "string") {
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    return undefined
  }
  if (type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string") {
      const cleaned = value.trim().replace(/,/g, "")
      if (/^-?\d+(\.\d+)?$/.test(cleaned)) return Number(cleaned)
    }
    return undefined
  }
  // boolean
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  return undefined
}

/**
 * PURE: adapt one external payload to the connector's canonical contract.
 * Deterministic — same payload + contract always produces the same result.
 */
export function adaptPayload(contract: ConnectorContract, raw: unknown): AdaptedPayload {
  const out: AdaptedPayload = { ok: false, canonical: {}, repairs: [], missingRequired: [], extensions: {}, driftRepairs: 0 }
  const rawObj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>

  const claimedTopLevel = new Set<string>()
  for (const field of contract.fields) {
    let resolved: string | number | boolean | undefined
    let kind: RepairKind | null = null
    let from: string | undefined

    for (let i = 0; i < field.paths.length; i++) {
      const path = field.paths[i]
      const value = readPath(rawObj, path)
      if (value === undefined || value === null || value === "") continue
      const sameType =
        (field.type === "string" && typeof value === "string") ||
        (field.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
        (field.type === "boolean" && typeof value === "boolean")
      if (sameType) {
        resolved = value as any
        kind = i === 0 ? "direct" : "alias"
        from = path
        break
      }
      const coerced = coerceValue(value, field.type)
      if (coerced !== undefined) {
        resolved = coerced
        kind = "coerced"
        from = path
        break
      }
      // value exists but can't be safely represented — keep looking; a later
      // path may hold the clean form. Never guess.
    }

    if (resolved === undefined) {
      if (field.required) {
        out.missingRequired.push(field.key)
        continue
      }
      out.canonical[field.key] = field.defaultValue ?? null
      // A null default on an absent optional is the EXPECTED shape, not a
      // repair — only a meaningful injected default counts as healing.
      if (field.defaultValue !== undefined && field.defaultValue !== null) out.repairs.push({ key: field.key, kind: "defaulted" })
      continue
    }

    out.canonical[field.key] = resolved
    out.repairs.push({ key: field.key, kind: kind!, from })
    if (from) claimedTopLevel.add(from.split(".")[0])
  }

  // EXTENSION CAPTURE: unknown top-level fields survive, clearly fenced.
  for (const [k, v] of Object.entries(rawObj)) {
    if (!claimedTopLevel.has(k)) out.extensions[k] = v
  }

  out.driftRepairs = out.repairs.filter((r) => r.kind !== "direct").length
  out.ok = out.missingRequired.length === 0
  return out
}

// ── Connector contracts (the connector memory) ──────────────────────────────

/** ShowingTime appointment — the shapes we've seen providers send, in priority order. */
export const SHOWINGTIME_APPOINTMENT_CONTRACT: ConnectorContract = {
  connector: "showingtime",
  entity: "appointment",
  fields: [
    { key: "id", type: "string", required: true, paths: ["id", "appointment_id", "appointmentId"] },
    { key: "requested_at", type: "string", required: true, paths: ["requested_at", "requestedAt", "start_time", "startTime"] },
    { key: "mls_number", type: "string", required: false, paths: ["property.mls_number", "property.mlsNumber", "property.mls_id", "mls_number"], defaultValue: null },
    { key: "listing_id", type: "string", required: false, paths: ["property.listing_id", "property.listingId", "listing_id"], defaultValue: null },
    { key: "address", type: "string", required: false, paths: ["property.address", "property.street_address", "property.streetAddress"], defaultValue: null },
    { key: "city", type: "string", required: false, paths: ["property.city"], defaultValue: null },
    { key: "state", type: "string", required: false, paths: ["property.state"], defaultValue: null },
    { key: "agent_name", type: "string", required: false, paths: ["buyer_agent.name", "buyerAgent.name", "agent.name"], defaultValue: null },
    { key: "agent_email", type: "string", required: false, paths: ["buyer_agent.email", "buyerAgent.email", "agent.email"], defaultValue: null },
    { key: "agent_phone", type: "string", required: false, paths: ["buyer_agent.phone", "buyerAgent.phone", "buyer_agent.phoneNumber", "buyerAgent.phoneNumber", "agent.phone"], defaultValue: null },
    { key: "agent_license", type: "string", required: false, paths: ["buyer_agent.license", "buyerAgent.license"], defaultValue: null },
    { key: "duration_minutes", type: "number", required: false, paths: ["duration_minutes", "durationMinutes", "duration"], defaultValue: 30 },
    { key: "notes", type: "string", required: false, paths: ["notes", "comments", "message"], defaultValue: null },
    { key: "external_ref", type: "string", required: false, paths: ["external_ref", "externalRef"], defaultValue: null },
    { key: "confirmed_at", type: "string", required: false, paths: ["confirmed_at", "confirmedAt"], defaultValue: null },
  ],
}
