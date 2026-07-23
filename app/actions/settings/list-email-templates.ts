'use server';

import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { isAdminOrBroker } from '@/lib/auth/resolve-user-role';

export async function listEmailTemplates() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: u } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .maybeSingle();
  if (!u?.brokerage_id) return [];
  // Email templates are brokerage-wide messaging config — the service-client read
  // (RLS-bypassing) must gate by role, matching the create/update template actions.
  if (!isAdminOrBroker(u)) return [];

  const svc = createServiceClient();
  const { data, error } = await svc
    .from('email_templates')
    .select('*')
    .eq('brokerage_id', u.brokerage_id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[settings] Error fetching email templates:', error);
    return [];
  }

  return data || [];
}
