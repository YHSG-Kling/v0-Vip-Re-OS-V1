// lib/agentic-os/resolve-vendor-capability.ts
// The AI-API agent's resolver: given a business CAPABILITY and a brokerage, return the
// LIVE, budget-aware answer an AI agent needs — which connector to use right now, its
// cost tier, whether it's allowed/degraded/blocked, and the business CONTEXT. This is
// the single entry point that lets agents "find the answer with context" instead of
// re-deriving vendor routing + gating at every call site.

// ─── /api/agentic-os/resolve-capability WAS NOT RETIRED (wave 14) ────────────
// A route census called that endpoint a duplicate of this module. It is not, and
// this module could not stand in for it if it were:
//   · `import "server-only"` (line below) means nothing outside this Node process
//     can reach this function. The route is the ONLY door an external agent has.
//     Its own header says as much: "Internal AI-agent server code calls
//     resolveVendorCapability() directly rather than over HTTP" — i.e. the HTTP
//     door exists precisely for the callers that are NOT internal.
//   · The route carries three things that live nowhere else: the
//     requirePlatformStaffAuth gate, validation of `capability` against
//     VENDOR_CAPABILITY_REGISTRY (with the available list in the 400), and a GET
//     discovery listing of the whole registry.
// Unreferenced by design (CLAUDE.md §1). UNRESOLVED — left in place.

import "server-only"
import { checkVendorBudget } from "@/lib/vendor-governance/budget-gate"
import {
  getVendorCapability,
  selectProvider,
  CAPABILITY_AGIS,
  type VendorCapability,
  type ProviderSelection,
  type AgisVerb,
} from "./vendor-capability-registry"

export interface ResolvedCapability {
  capability: VendorCapability
  domain: string
  /** Agentic-API action metadata (agenticapi.com): intent verb + scope + weight. */
  verb: AgisVerb
  scope: string
  intentWeight: number
  /** Business context an agent reads to understand what this answers + how to use it. */
  purpose: string
  inputs: string[]
  /** All providers (priority order) so the agent sees the full ladder. */
  providers: Array<{ vendor: string; tier: "free" | "paid"; note: string }>
  /** The live, budget-aware selection. */
  selection: ProviderSelection
  /** Budget posture: ok | approaching | paused. */
  budgetLevel: "ok" | "approaching" | "paused"
}

/**
 * Resolve a capability for a brokerage. Reads the brokerage's live vendor-budget
 * posture and applies the downgrade ladder. Never throws — on any error it returns
 * the under-budget (allow primary) selection so the product keeps working.
 */
export async function resolveVendorCapability(
  capability: VendorCapability,
  params: { brokerageId?: string | null },
): Promise<ResolvedCapability> {
  const def = getVendorCapability(capability)

  let overBudget = false
  let budgetLevel: ResolvedCapability["budgetLevel"] = "ok"
  if (params.brokerageId) {
    try {
      const budget = await checkVendorBudget({ brokerageId: params.brokerageId })
      overBudget = !budget.allowed
      budgetLevel = !budget.allowed ? "paused" : budget.softWarning ? "approaching" : "ok"
    } catch {
      // Fail open — never block an agent's resolution on a budget read error.
    }
  }

  const agis = CAPABILITY_AGIS[capability]
  return {
    capability,
    domain: def.domain,
    verb: agis.verb,
    scope: agis.scope,
    intentWeight: agis.intentWeight,
    purpose: def.purpose,
    inputs: def.inputs,
    providers: def.providers.map((p) => ({ vendor: p.vendor, tier: p.tier, note: p.note })),
    selection: selectProvider(capability, { overBudget }),
    budgetLevel,
  }
}
