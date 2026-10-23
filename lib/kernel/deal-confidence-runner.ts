// lib/kernel/deal-confidence-runner.ts
//
// TOMBSTONE (orphan tranche 4): runDealConfidence deleted. It re-ran
// calculateDealHealth and then distilled — contradicting the deal_confidence
// registry ruling ("this does NOT recompute it — pure distillDealConfidence
// DISTILLS the existing components"). The survivors:
//   · lib/kernel/deal-confidence.ts:distillDealConfidence — the pure distiller,
//     wired live at app/transactions/[transactionId]/page.tsx over the STORED
//     health components (transactions.health_score written by the health scorer);
//   · lib/deal-health/health-scorer.ts:calculateDealHealth — the recompute,
//     already run by the deal-health scan and after every stage transition.
// Composing the two is two lines at any future call site; a wrapper that does it
// against the ruling is not capability, it is drift.
export {}
