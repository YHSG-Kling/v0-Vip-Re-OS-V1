export interface CreditCost {
  operation: string;
  creditsRequired: number;
  estimatedMonthlyUsage: number;
}

// Define credit costs for different operations
export const CREDIT_COSTS = {
  api_call: 1,
  data_enrichment: 5,
  video_generation: 50,
  email_send: 0.5,
  sms_send: 1,
  lead_scrape: 10,
} as const;

export function calculateCreditsForOperation(
  operation: keyof typeof CREDIT_COSTS,
  quantity: number = 1
): number {
  const cost = CREDIT_COSTS[operation];
  return cost * quantity;
}

export function calculateMonthlyUsageEstimate(
  operations: Array<{
    type: keyof typeof CREDIT_COSTS;
    monthlyQuantity: number;
  }>
): number {
  return operations.reduce((total, op) => {
    return total + calculateCreditsForOperation(op.type, op.monthlyQuantity);
  }, 0);
}

export function recommendPlanByUsage(
  estimatedMonthlyCredits: number,
  creditCostPerThousand: number = 5
): {
  recommendedPlan: 'starter' | 'pro' | 'enterprise';
  estimatedMonthlyCost: number;
} {
  const costPerCredit = creditCostPerThousand / 1000;
  const estimatedCost = estimatedMonthlyCredits * costPerCredit;

  if (estimatedMonthlyCredits <= 1000) {
    return {
      recommendedPlan: 'starter',
      estimatedMonthlyCost: 29,
    };
  } else if (estimatedMonthlyCredits <= 10000) {
    return {
      recommendedPlan: 'pro',
      estimatedMonthlyCost: 99,
    };
  } else {
    return {
      recommendedPlan: 'enterprise',
      estimatedMonthlyCost: estimatedCost,
    };
  }
}
