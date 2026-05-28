'use server';

import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

const CREATE_ROLES = ['broker', 'broker_owner', 'broker_admin', 'admin', 'super_admin', 'superadmin'];

export async function createEmailTemplate(template: any) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  const { data: u } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .maybeSingle();
  if (!u?.brokerage_id) return { error: 'Unauthorized' };
  if (!CREATE_ROLES.includes(u.user_type ?? '')) return { error: 'Forbidden' };

  // Strip any caller-supplied id / brokerage_id from the payload so we can't
  // forge rows into other brokerages.
  const { id: _id, brokerage_id: _b, ...safe } = template ?? {};

  const svc = createServiceClient();
  const { data, error } = await svc
    .from('email_templates')
    .insert({
      ...safe,
      brokerage_id: u.brokerage_id,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    console.error('[settings] Error creating email template:', error);
    return { error: 'Failed to create email template' };
  }

  return { data };
}
