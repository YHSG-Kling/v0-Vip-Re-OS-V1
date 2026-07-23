'use server';

import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { isAdminOrBroker } from '@/lib/auth/resolve-user-role';

// Commission/rev-share structures are broker-level config — the same roles that
// may CREATE them (create-commission-structure.ts) may read them. This read used
// the service client (RLS-bypassing) gated only by brokerage, so any brokerage
// member (a plain agent) could see the whole split table. Gate it by role using
// the canonical broker-level helper.
export async function listCommissionStructures() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: u } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .maybeSingle();
  if (!u?.brokerage_id) return [];
  if (!isAdminOrBroker(u)) return [];

  const svc = createServiceClient();
  const { data, error } = await svc
    .from('commission_structures')
    .select('*')
    .eq('brokerage_id', u.brokerage_id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[settings] Error fetching commission structures:', error);
    return [];
  }

  return data || [];
}
