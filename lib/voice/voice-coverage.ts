// lib/voice/voice-coverage.ts
//
// VOICE-COMMAND GOVERNANCE COVERAGE (pure) — the voice analog of egress-coverage / signal-integrity.
// The voice cockpit lets a broker speak commands and the AI team ACTS; the tool-registry declares each
// tool's authority + compliance gates, but until now nothing PROVED the registry is internally
// consistent. A future tool added as outbound-without-a-gate, telco-without-TCPA, or an acting tool left
// open to any authenticated user is exactly the "future-bug factory" the registry warns about. This
// encodes the invariants so test:voice-coverage fails the moment one is violated. Pure (no I/O).

import { voiceTools, type VoiceTool, type ComplianceGate, type ToolAuthority } from "./tool-registry"

const VALID_CATEGORIES = new Set<VoiceTool["category"]>(["lookup", "draft", "send", "schedule", "stage", "report"])
const VALID_AUTHORITIES = new Set<ToolAuthority>(["agent", "agent_or_isa", "tenant_staff", "admin", "any_authenticated"])
const VALID_GATES = new Set<ComplianceGate>(["active_bba", "tcpa_outbound", "evaluate_outbound", "ai_fair_use", "dnc_check", "service_role", "entity_owner"])

/**
 * Tools that ARE outbound but enforce their gate in the BACKEND rather than declaring a registry gate —
 * each documented here with WHY. The coverage gate accepts these and rejects any OTHER ungated outbound
 * tool. Keep this list tiny and justified.
 */
export const GATE_DELEGATED: Record<string, string> = {
  // Re-derives the stand-up live and routes each item to its own rail's gate (approval→gate as the
  // agent; reengage→follow-up through evaluate_outbound; a fire drill is never auto-resolved).
  standup_action: "each ranked item routes to its rail's own gate",
  // The buyer e-sign envelope: BBA is a HARD gate enforced in the handler (refuses dispatch until the
  // BBA is signed) — stronger than a pre-flight content gate.
  dispatch_transaction_packet: "BBA hard gate enforced in the dispatch handler",
}

export interface VoiceCoverageViolation {
  tool: string
  rule: string
  detail: string
}

/**
 * PURE + total. Return every invariant violation across the whole voice tool registry. Empty = healthy.
 * Invariants:
 *   1. shape — valid category / authority / gate enum values + a non-empty description.
 *   2. read-only — lookup/report tools cannot be outbound or telco-initiating.
 *   3. outbound gating — an is_outbound tool must declare a content gate, OR be is_nar_regulated
 *      (BBA/handler-gated), OR be explicitly GATE_DELEGATED. No silent ungated outbound.
 *   4. telco — an is_telco_initiating tool MUST include tcpa_outbound.
 *   5. acting scope — send/stage/schedule (acting) tools must NOT be any_authenticated.
 */
export function voiceCoverageViolations(): VoiceCoverageViolation[] {
  const out: VoiceCoverageViolation[] = []
  for (const [name, tool] of Object.entries(voiceTools)) {
    if (tool.name !== name) out.push({ tool: name, rule: "shape", detail: `name mismatch (${tool.name})` })
    if (!VALID_CATEGORIES.has(tool.category)) out.push({ tool: name, rule: "shape", detail: `bad category ${tool.category}` })
    if (!VALID_AUTHORITIES.has(tool.authority)) out.push({ tool: name, rule: "shape", detail: `bad authority ${tool.authority}` })
    for (const g of tool.gates) if (!VALID_GATES.has(g)) out.push({ tool: name, rule: "shape", detail: `bad gate ${g}` })
    if (!tool.description || tool.description.trim().length < 10) out.push({ tool: name, rule: "shape", detail: "missing/short description" })

    const readOnly = tool.category === "lookup" || tool.category === "report"
    if (readOnly && (tool.is_outbound || tool.is_telco_initiating)) {
      out.push({ tool: name, rule: "read-only", detail: "lookup/report tool flagged outbound/telco" })
    }

    if (tool.is_outbound) {
      const hasContentGate = tool.gates.includes("evaluate_outbound") || tool.gates.includes("tcpa_outbound") || tool.gates.includes("dnc_check")
      if (!hasContentGate && !tool.is_nar_regulated && !(name in GATE_DELEGATED)) {
        out.push({ tool: name, rule: "outbound-gating", detail: "outbound tool with no content gate, not NAR-regulated, not GATE_DELEGATED" })
      }
    }

    if (tool.is_telco_initiating && !tool.gates.includes("tcpa_outbound")) {
      out.push({ tool: name, rule: "telco-tcpa", detail: "telco-initiating tool missing tcpa_outbound" })
    }

    const acting = tool.category === "send" || tool.category === "stage" || tool.category === "schedule"
    if (acting && tool.authority === "any_authenticated") {
      out.push({ tool: name, rule: "acting-scope", detail: "acting tool must not be any_authenticated" })
    }
  }
  return out
}

/** Every registered voice tool name. */
export function registeredVoiceTools(): string[] {
  return Object.keys(voiceTools)
}
