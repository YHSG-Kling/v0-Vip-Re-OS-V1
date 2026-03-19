'use server';

import { createServiceClient } from '@/lib/supabase/service';

// Default settings when none exist
const DEFAULT_GLOBAL_SETTINGS = {
  app_name: 'VIP Agents AI',
  app_logo_url: null,
  primary_color: '#2563eb',
  secondary_color: '#1e40af',
  font_family: 'Inter',
  fiscal_year_start: 1,
  timezone: 'America/New_York',
  date_format: 'MM/DD/YYYY',
  currency_symbol: '$',
  email_notifications_enabled: true,
  sms_notifications_enabled: false,
  push_notifications_enabled: false,
};

export async function getGlobalSettings() {
  const supabase = createServiceClient();
  
  const { data, error } = await supabase
    .from('global_settings')
    .select('*')
    .limit(1)
    .maybeSingle();
    
  if (error) {
    console.error('[v0] Error fetching global settings:', error);
    // Return defaults instead of throwing
    return DEFAULT_GLOBAL_SETTINGS;
  }
  
  // Return data if exists, otherwise return defaults
  return data ?? DEFAULT_GLOBAL_SETTINGS;
}
