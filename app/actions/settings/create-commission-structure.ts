'use server';

import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

const CREATE_ROLES = ['broker', 'broker_owner', 'admin', 'superadmin'];

export async function createCommissionStructure(structure: any) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .maybeSingle();
  if (!userData?.brokerage_id) return { error: 'Unauthorized' };
  if (!CREATE_ROLES.includes(userData.user_type ?? '')) return { error: 'Forbidden' };

  // Strip any caller-supplied brokerage_id and stamp from session
  const { id: _droppedId, brokerage_id: _droppedBrokerage, ...safeStructure } = structure ?? {};

  const svc = createServiceClient();
  const { data, error } = await svc
    .from('commission_structures')
    .insert({
      ...safeStructure,
      brokerage_id: userData.brokerage_id,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    console.error('[settings] Error creating commission structure:', error);
    return { error: 'Failed to create commission structure' };
  }

  return { data };
}
