// lib/kernel/deal-confidence-runner.ts
//
// Makes Deal Confidence LIVE: runs the existing fused deal-health score (calculateDealHealth) and
// distills it into the verdict + single weakest link + the one protective action. Pure distillation
// over the existing components (ComponentScore already carries score + weight) — no recompute.

import "server-only"
import { distillDealConfidence, type DealConfidence, type ConfidenceComponent } from "./deal-confidence"

/** Compute (or read) deal health for a transaction and distill it to confidence + weakest link. */
export async function runDealConfidence(
  transactionId: string,
  brokerageId: string,
): Promise<DealConfidence | null> {
  try {
    const { calculateDealHealth } = await import("@/lib/deal-health/health-scorer")
    const health = await calculateDealHealth({ transactionId, brokerageId })
    if (!health) return null
    const components: ConfidenceComponent[] = (health.components ?? []).map((c: any) => ({
      category: c.category, score: c.score, weight: c.weight, issues: c.issues ?? c.flags,
    }))
    return distillDealConfidence(health.overallScore, components, health.riskLevel)
  } catch {
    return null
  }
}
