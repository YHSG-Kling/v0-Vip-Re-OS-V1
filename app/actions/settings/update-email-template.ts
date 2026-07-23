'use server';

import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { isAdminOrBroker } from '@/lib/auth/resolve-user-role';

export async function updateEmailTemplate(id: string, updates: any) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .maybeSingle();
  if (!userData?.brokerage_id) return { error: 'Unauthorized' };
  // Email templates are broker-level config — the create side gates by role, so
  // the update must too (this write used the service client, RLS-bypassing).
  if (!isAdminOrBroker(userData)) return { error: 'Forbidden' };

  const svc = createServiceClient();

  // Verify the template row belongs to the caller's brokerage before mutating
  const { data: existing } = await svc
    .from('email_templates')
    .select('brokerage_id')
    .eq('id', id)
    .maybeSingle();
  if (!existing) return { error: 'Template not found' };
  if (existing.brokerage_id !== userData.brokerage_id) return { error: 'Forbidden' };

  const { data, error } = await svc
    .from('email_templates')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('brokerage_id', userData.brokerage_id)
    .select()
    .single();

  if (error) {
    console.error('[settings] Error updating email template:', error);
    return { error: 'Failed to update email template' };
  }

  return { data };
}
