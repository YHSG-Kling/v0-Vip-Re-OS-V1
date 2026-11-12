/**
 * Chain registry — all workflow chains are defined here.
 * Adding a new chain: import its definition and add to ALL_CHAINS.
 */

import type { WorkflowChain } from "../types"
import { listingApptPrepChain } from "./listing-appt-prep"
import { complianceListingAutoCreateChain } from "./compliance-listing-auto-create"
import { complianceTransactionAutoCreateChain } from "./compliance-transaction-auto-create"

// UN-EXPORTED (§1.1, 2026-08-31, lane M4): the registry's public doors are
// getChainByKey / getChainsByTrigger below (live: engine.ts, orchestrator
// internal, workflow-orchestrator action); no file read the raw array.
const ALL_CHAINS: WorkflowChain[] = [
  listingApptPrepChain,
  complianceListingAutoCreateChain,
  complianceTransactionAutoCreateChain,
]

const CHAINS_BY_KEY: Record<string, WorkflowChain> = Object.fromEntries(
  ALL_CHAINS.map((c) => [c.key, c])
)

const CHAINS_BY_TRIGGER: Record<string, WorkflowChain[]> = {}
for (const chain of ALL_CHAINS) {
  if (!CHAINS_BY_TRIGGER[chain.triggerEvent]) CHAINS_BY_TRIGGER[chain.triggerEvent] = []
  CHAINS_BY_TRIGGER[chain.triggerEvent].push(chain)
}

export function getChainByKey(key: string): WorkflowChain | undefined {
  return CHAINS_BY_KEY[key]
}

export function getChainsByTrigger(eventType: string): WorkflowChain[] {
  return CHAINS_BY_TRIGGER[eventType] ?? []
}
