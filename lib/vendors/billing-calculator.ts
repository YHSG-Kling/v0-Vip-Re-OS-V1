export interface BillingCalculation {
  subtotal: number;
  tax: number;
  total: number;
  creditsIncluded: number;
  pricePerCredit: number;
}

export function calculateMonthlyBilling(
  planPrice: number,
  creditsIncluded: number,
  creditsUsed: number,
  extraCreditPrice: number,
  taxRate: number = 0.08
): BillingCalculation {
  let subtotal = planPrice;

  // Add overage charges
  if (creditsUsed > creditsIncluded) {
    const overage = creditsUsed - creditsIncluded;
    subtotal += overage * extraCreditPrice;
  }

  const tax = Math.round(subtotal * taxRate * 100) / 100;
  const total = subtotal + tax;

  return {
    subtotal,
    tax,
    total,
    creditsIncluded,
    pricePerCredit: extraCreditPrice,
  };
}

export function calculateVendorRevenue(
  chargeAmount: number,
  revenuSharePercent: number
): {
  vendorEarns: number;
  platformEarns: number;
} {
  const vendorEarns = Math.round((chargeAmount * revenuSharePercent) / 100 * 100) / 100;
  const platformEarns = chargeAmount - vendorEarns;

  return {
    vendorEarns,
    platformEarns,
  };
}

export function calculateAnnualDiscount(monthlyPrice: number, discountPercent: number = 10): number {
  const annualPrice = monthlyPrice * 12;
  const discount = Math.round((annualPrice * discountPercent) / 100 * 100) / 100;
  return Math.round((annualPrice - discount) * 100) / 100;
}
