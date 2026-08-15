'use server';

import { createClient } from '@/lib/supabase/server';
import { updateGlobalSettings as kernelUpdateGlobalSettings } from '@/lib/kernel';

// Non-secret fields the settings forms are allowed to write. SMTP + API keys are
// handled by dedicated hardened actions, never here.
//
// `app_name` IS NOT ON THIS LIST, DELIBERATELY. It is a MIRROR of
// `brokerages.name`, not an independently editable value. The "Brokerage Info"
// card used to type a brokerage name into app_name while nothing ever wrote
// brokerages.name — so renaming a brokerage on the settings screen changed the
// client-facing display name and NOT the column the compliance/disclosure
// resolver (lib/brokerage/compliance-identity.ts) reads. The single name field
// now writes brokerages.name and app_name is stepped forward from it, in
// app/actions/settings/brokerage-identity.ts:updateBrokerageIdentity. Adding
// app_name back here would re-open that drift.
const ALLOWED_FIELDS = [
  'app_logo_url',
  'primary_color',
  'secondary_color',
  'font_family',
  'fiscal_year_start',
  'timezone',
  'date_format',
  'currency_symbol',
  'email_notifications_enabled',
  'sms_notifications_enabled',
  'push_notifications_enabled',
] as const;

// Delegates to the kernel (single source of truth). The kernel is brokerage-scoped
// and self-seeds the row, so this succeeds on a fresh brokerage instead of
// returning "Settings not found". The client-supplied `id` is intentionally
// ignored — the row is always resolved from the caller's brokerage.
export async function updateGlobalSettings(updates: Record<string, unknown>) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.id) return { error: 'Unauthorized' };

    const clean: Record<string, unknown> = {};
    for (const key of ALLOWED_FIELDS) {
      if (updates[key] !== undefined) clean[key] = updates[key];
    }

    await kernelUpdateGlobalSettings({ userId: user.id, updates: clean as any });
    return { data: true };
  } catch (error) {
    console.error('[settings] Error updating global settings:', error);
    const message =
      error instanceof Error && error.message.startsWith('Forbidden')
        ? 'You do not have permission to change these settings.'
        : 'Failed to update settings';
    return { error: message };
  }
}
