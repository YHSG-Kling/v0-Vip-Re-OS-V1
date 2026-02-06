export interface CommissionCalculation {
  amount: number;
  type: string;
  percentage?: number;
}

export function calculateCommission(
  salePrice: number,
  structure: any
): CommissionCalculation {
  if (structure.commission_type === 'percentage') {
    return {
      amount: (salePrice * structure.base_percentage) / 100,
      type: 'percentage',
      percentage: structure.base_percentage,
    };
  }

  if (structure.commission_type === 'flat') {
    return {
      amount: structure.base_amount,
      type: 'flat',
    };
  }

  if (structure.commission_type === 'tiered' && structure.tier_rules) {
    const tiers = JSON.parse(structure.tier_rules);
    for (const tier of tiers) {
      if (salePrice >= tier.threshold) {
        return {
          amount: (salePrice * tier.percentage) / 100,
          type: 'tiered',
          percentage: tier.percentage,
        };
      }
    }
  }

  return { amount: 0, type: 'unknown' };
}
