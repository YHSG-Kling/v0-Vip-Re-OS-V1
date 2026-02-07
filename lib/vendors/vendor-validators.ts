export function validateVendor(data: any) {
  const errors: string[] = [];

  if (!data.company_name || data.company_name.trim().length === 0) {
    errors.push('Company name is required');
  }

  if (data.company_name && data.company_name.length > 100) {
    errors.push('Company name must be less than 100 characters');
  }

  if (!data.category || !['api', 'service', 'tool', 'integration'].includes(data.category)) {
    errors.push('Valid category is required');
  }

  if (data.website && !/^https?:\/\/.+\..+/.test(data.website)) {
    errors.push('Website must be a valid URL');
  }

  if (data.default_revenue_share_percent < 0 || data.default_revenue_share_percent > 100) {
    errors.push('Revenue share must be between 0 and 100');
  }

  return errors;
}

export function validateVendorPlan(data: any) {
  const errors: string[] = [];

  if (!data.name || data.name.trim().length === 0) {
    errors.push('Plan name is required');
  }

  if (!data.price_per_month || data.price_per_month <= 0) {
    errors.push('Price must be greater than 0');
  }

  if (!['monthly', 'annual'].includes(data.billing_cycle)) {
    errors.push('Invalid billing cycle');
  }

  if (data.max_credits_per_month && data.max_credits_per_month < 0) {
    errors.push('Max credits cannot be negative');
  }

  return errors;
}
