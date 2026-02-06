export const DEFAULT_GLOBAL_SETTINGS = {
  app_name: 'VIP Real Estate OS',
  timezone: 'America/New_York',
  date_format: 'MM/DD/YYYY',
  currency_symbol: '$',
  fiscal_year_start: 1,
  email_notifications_enabled: true,
  sms_notifications_enabled: false,
  push_notifications_enabled: false,
  primary_color: '#2563eb',
  secondary_color: '#1e40af',
  font_family: 'system-ui',
};

export const COMMISSION_TYPES = ['percentage', 'flat', 'tiered'] as const;
export const TEMPLATE_TYPES = ['welcome', 'offer', 'closing', 'followup', 'reminder'] as const;
export const NOTIFICATION_TYPES = ['email', 'sms', 'push'] as const;
export const RECIPIENT_ROLES = ['agent', 'broker', 'admin', 'TC', 'lender', 'title_agent', 'vendor', 'contact', 'isa', 'compliance_officer'] as const;
export const TRIGGER_EVENTS = ['new_lead', 'offer_received', 'contract_signed', 'ready_to_close', 'listing_created', 'contact_claimed'] as const;

export const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
] as const;

export const DATE_FORMATS = [
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'YYYY-MM-DD',
] as const;

export const CURRENCY_SYMBOLS = ['$', '€', '£', '¥'] as const;
