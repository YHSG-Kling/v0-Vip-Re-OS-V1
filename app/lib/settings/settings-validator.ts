export function validateGlobalSettings(data: any) {
  const errors: string[] = [];

  if (!data.app_name || data.app_name.trim().length === 0) {
    errors.push('App name is required');
  }

  if (!data.timezone) {
    errors.push('Timezone is required');
  }

  if (!['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'].includes(data.date_format)) {
    errors.push('Invalid date format');
  }

  if (!data.primary_color || !/^#[0-9A-F]{6}$/i.test(data.primary_color)) {
    errors.push('Invalid primary color');
  }

  if (data.currency_symbol && data.currency_symbol.length > 5) {
    errors.push('Currency symbol too long');
  }

  return errors;
}

export function validateCommissionStructure(data: any) {
  const errors: string[] = [];

  if (!data.name || data.name.trim().length === 0) {
    errors.push('Commission structure name is required');
  }

  if (!['percentage', 'flat', 'tiered'].includes(data.commission_type)) {
    errors.push('Invalid commission type');
  }

  if (data.commission_type === 'percentage') {
    if (!data.base_percentage || data.base_percentage < 0 || data.base_percentage > 100) {
      errors.push('Base percentage must be between 0 and 100');
    }
  }

  if (data.commission_type === 'flat') {
    if (!data.base_amount || data.base_amount <= 0) {
      errors.push('Base amount must be greater than 0');
    }
  }

  return errors;
}

export function validateEmailTemplate(data: any) {
  const errors: string[] = [];

  if (!data.name || data.name.trim().length === 0) {
    errors.push('Template name is required');
  }

  if (!data.subject || data.subject.trim().length === 0) {
    errors.push('Subject is required');
  }

  if (!data.body || data.body.trim().length === 0) {
    errors.push('Template body is required');
  }

  if (!['welcome', 'offer', 'closing', 'followup', 'reminder'].includes(data.template_type)) {
    errors.push('Invalid template type');
  }

  return errors;
}

export function validateIntegrationCredentials(data: any) {
  const errors: string[] = [];

  if (!data.provider_name) {
    errors.push('Provider name is required');
  }

  if (!data.api_key || data.api_key.trim().length === 0) {
    errors.push('API key is required');
  }

  return errors;
}
