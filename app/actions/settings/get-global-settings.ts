'use server';

import { createClient } from '@/lib/supabase/server';
import { getGlobalSettings as kernelGetGlobalSettings } from '@/lib/kernel';

// Default settings returned when the caller cannot load a real, brokerage-scoped
// row (e.g. not signed in, or not an admin/broker). The settings pages that use
// this render read-only defaults in that case rather than erroring.
const DEFAULT_GLOBAL_SETTINGS = {
  app_name: 'VIP Real Estate OS',
  app_logo_url: null,
  primary_color: '#2563eb',
  secondary_color: '#1e40af',
  font_family: 'system-ui',
  fiscal_year_start: 1,
  timezone: 'America/New_York',
  date_format: 'MM/DD/YYYY',
  currency_symbol: '$',
  email_notifications_enabled: true,
  sms_notifications_enabled: false,
  push_notifications_enabled: false,
};

// Brokerage-scoped read that delegates to the kernel (single source of truth).
// The kernel self-seeds the row on first access, so a fresh brokerage returns a
// real row with an id instead of the old un-saveable defaults.
export async function getGlobalSettings() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.id) return DEFAULT_GLOBAL_SETTINGS;

    return await kernelGetGlobalSettings({ userId: user.id });
  } catch (error) {
    console.error('[settings] Error fetching global settings:', error);
    return DEFAULT_GLOBAL_SETTINGS;
  }
}
