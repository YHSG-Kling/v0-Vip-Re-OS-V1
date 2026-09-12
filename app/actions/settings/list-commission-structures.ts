'use server';

import { createServiceClient } from '@/lib/supabase/service';
import { isBrokerageFinanceAdmin } from '@/lib/auth/resolve-user-role';
// ACT-AS SEAM (read side) — the finance gate is evaluated on the EFFECTIVE
// (impersonated) identity's user_type, never the raw staff row.
import { resolveActingContext } from '@/lib/platform/acting-context';

// Commission/rev-share structures are broker-level config — the same roles that
// may CREATE them (create-commission-structure.ts) may read them. This read used
// the service client (RLS-bypassing) gated only by brokerage, so any brokerage
// member (a plain agent) could see the whole split table. Gate it by role using
// the canonical broker-level helper.
export async function listCommissionStructures() {
  const ctx = await resolveActingContext();
  if (!ctx.ok || !ctx.brokerageId) return [];
  if (!isBrokerageFinanceAdmin({ user_type: ctx.userType })) return [];

  const svc = createServiceClient();
  const { data, error } = await svc
    .from('commission_structures')
    .select('*')
    .eq('brokerage_id', ctx.brokerageId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[settings] Error fetching commission structures:', error);
    return [];
  }

  return data || [];
}
