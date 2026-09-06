'use server';

import { createServiceClient } from '@/lib/supabase/service';
import { isAdminOrBroker } from '@/lib/auth/resolve-user-role';
// ACT-AS SEAM (read side) — the role gate is evaluated on the EFFECTIVE
// (impersonated) identity's user_type, never the raw staff row.
import { resolveActingContext } from '@/lib/platform/acting-context';

export async function listEmailTemplates() {
  const ctx = await resolveActingContext();
  if (!ctx.ok || !ctx.brokerageId) return [];
  // Email templates are brokerage-wide messaging config — the service-client read
  // (RLS-bypassing) must gate by role, matching the create/update template actions.
  if (!isAdminOrBroker({ user_type: ctx.userType })) return [];

  const svc = createServiceClient();
  const { data, error } = await svc
    .from('email_templates')
    .select('*')
    .eq('brokerage_id', ctx.brokerageId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[settings] Error fetching email templates:', error);
    return [];
  }

  return data || [];
}
