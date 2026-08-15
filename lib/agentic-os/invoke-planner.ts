// lib/agentic-os/invoke-planner.ts
// The DESCRIBE + INVOKE brain of the Agentic API (agenticapi.com ACTION model). Pure:
// given an action, the caller's scopes, the supplied inputs, and the live budget
// posture, it decides what should happen — WITHOUT performing any I/O. The route layer
// executes the decision. This keeps the gating (scope → input validation → budget /
// downgrade ladder → intent-weight confirmation) deterministic and unit-testable.

import {
  getVendorCapability,
  selectProvider,
  CAPABILITY_AGIS,
  type VendorCapability,
  type ProviderSelection,
  type AgisVerb,
} from "./vendor-capability-registry"
import { hasScope } from "./agent-scopes"
import {
  getConnectedCapability,
  connectedIntentWeight,
  type ConnectedCapability,
} from "./connected-vendor-registry"

// Side-effecting AGIS verbs always require explicit confirmation — they place calls,
// render media, or delegate/escalate to humans. Read verbs (FIND/ANALYZE/ENRICH/
// DISCOVER/DESCRIBE) execute directly. High-intent-weight actions also require
// confirmation even under a read verb (e.g. FIND that spends on lead sourcing).
export const SIDE_EFFECTING_VERBS: ReadonlySet<AgisVerb> = new Set(["RENDER", "NOTIFY", "DELEGATE", "ESCALATE"])
export const CONFIRMATION_THRESHOLD = 0.9

export type InvokeDecision =
  | "execute"               // run it (read/analyze, within budget or degraded)
  | "requires_confirmation" // high-weight side-effecting — return a plan, don't fire
  | "unauthorized"          // caller lacks the required scope
  | "invalid_input"         // required inputs missing
  | "blocked"               // over budget with no free alternative

export interface InputSpec {
  name: string
  required: boolean
}

/** Pure: parse registry input tokens ("zipCode?" → optional) into a typed spec. */
export function parseInputSpec(inputs: string[]): InputSpec[] {
  return inputs.map((raw) => {
    const optional = raw.endsWith("?")
    return { name: optional ? raw.slice(0, -1) : raw, required: !optional }
  })
}

export interface InvocationPlan {
  capability: VendorCapability
  decision: InvokeDecision
  /** Required inputs that were not supplied (only when decision = invalid_input). */
  missingInputs: string[]
  /** The budget-aware provider selection (the route may degrade to a free path). */
  selection: ProviderSelection
  intentWeight: number
  scope: string
  reason: string
}

/**
 * Pure: plan an invocation. Order of gates: scope → required-inputs → budget/ladder →
 * intent-weight confirmation. Never throws.
 */
export function planInvocation(
  capability: VendorCapability,
  args: {
    inputs: Record<string, unknown>
    grantedScopes: readonly string[] | null | undefined
    overBudget: boolean
  },
): InvocationPlan {
  const def = getVendorCapability(capability)
  const agis = CAPABILITY_AGIS[capability]
  const selection = selectProvider(capability, { overBudget: args.overBudget })
  const base = { capability, missingInputs: [] as string[], selection, intentWeight: agis.intentWeight, scope: agis.scope }

  // 1. Scope gate
  if (!hasScope(args.grantedScopes, agis.scope)) {
    return { ...base, decision: "unauthorized", reason: `Missing required scope: ${agis.scope}` }
  }
  // 2. Required-input gate
  const missing = parseInputSpec(def.inputs)
    .filter((s) => s.required && (args.inputs[s.name] === undefined || args.inputs[s.name] === null || args.inputs[s.name] === ""))
    .map((s) => s.name)
  if (missing.length > 0) {
    return { ...base, missingInputs: missing, decision: "invalid_input", reason: `Missing required inputs: ${missing.join(", ")}` }
  }
  // 3. Budget / downgrade ladder
  if (selection.action === "block") {
    return { ...base, decision: "blocked", reason: selection.reason }
  }
  // 4. Confirmation gate — side-effecting verbs, or high-intent-weight read actions.
  if (SIDE_EFFECTING_VERBS.has(agis.verb) || agis.intentWeight >= CONFIRMATION_THRESHOLD) {
    return { ...base, decision: "requires_confirmation", reason: `${agis.verb} (weight ${agis.intentWeight}) requires explicit confirmation` }
  }
  return { ...base, decision: "execute", reason: selection.usingFreeFallback ? "executing on free tier (degraded)" : "authorized" }
}

// ─── User-connected capability planning ───────────────────────────────────────
// User-connected vendors are NOT budget-gated (the brokerage pays the vendor). The
// gate is: scope → required inputs → CONNECTION presence → confirmation. Pure: the
// route resolves `connected` (connection-manager) and passes it in.

export type ConnectedInvokeDecision =
  | "execute"
  | "requires_confirmation"
  | "unauthorized"
  | "invalid_input"
  | "not_connected" // the brokerage has not connected any provider for this capability

export interface ConnectedInvocationPlan {
  capability: ConnectedCapability
  decision: ConnectedInvokeDecision
  missingInputs: string[]
  /** Providers the brokerage could connect (only when decision = not_connected). */
  missingConnections: string[]
  intentWeight: number
  scope: string
  reason: string
}

/**
 * Pure: plan a user-connected capability invocation. Order of gates: scope →
 * required-inputs → connection presence → confirmation. Never throws.
 */
export function planConnectedInvocation(
  capability: ConnectedCapability,
  args: {
    inputs: Record<string, unknown>
    grantedScopes: readonly string[] | null | undefined
    connected: boolean
  },
): ConnectedInvocationPlan {
  const def = getConnectedCapability(capability)
  const intentWeight = connectedIntentWeight(def)
  const base = {
    capability,
    missingInputs: [] as string[],
    missingConnections: [] as string[],
    intentWeight,
    scope: def.scope,
  }

  // 1. Scope gate
  if (!hasScope(args.grantedScopes, def.scope)) {
    return { ...base, decision: "unauthorized", reason: `Missing required scope: ${def.scope}` }
  }
  // 2. Required-input gate
  const missing = parseInputSpec(def.inputs)
    .filter((s) => s.required && (args.inputs[s.name] === undefined || args.inputs[s.name] === null || args.inputs[s.name] === ""))
    .map((s) => s.name)
  if (missing.length > 0) {
    return { ...base, missingInputs: missing, decision: "invalid_input", reason: `Missing required inputs: ${missing.join(", ")}` }
  }
  // 3. Connection gate — the brokerage must have connected a provider for this capability.
  if (!args.connected) {
    return { ...base, missingConnections: def.connections, decision: "not_connected", reason: `No connected provider — connect one of: ${def.connections.join(", ")}` }
  }
  // 4. Confirmation gate — side-effecting verbs or any mutating write.
  if (SIDE_EFFECTING_VERBS.has(def.verb) || def.mutates || intentWeight >= CONFIRMATION_THRESHOLD) {
    return { ...base, decision: "requires_confirmation", reason: `${def.verb} ${capability} requires explicit confirmation` }
  }
  return { ...base, decision: "execute", reason: "authorized + connected" }
}
