'use server';

import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

const DELETE_ROLES = ['broker', 'broker_owner', 'admin', 'superadmin'];

export async function deleteCommissionStructure(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .maybeSingle();
  if (!userData?.brokerage_id) return { error: 'Unauthorized' };
  if (!DELETE_ROLES.includes(userData.user_type ?? '')) return { error: 'Forbidden' };

  const svc = createServiceClient();

  // Verify the commission structure belongs to the caller's brokerage before deleting
  const { data: existing } = await svc
    .from('commission_structures')
    .select('brokerage_id')
    .eq('id', id)
    .maybeSingle();
  if (!existing) return { error: 'Commission structure not found' };
  if (existing.brokerage_id !== userData.brokerage_id) return { error: 'Forbidden' };

  const { error } = await svc
    .from('commission_structures')
    .delete()
    .eq('id', id)
    .eq('brokerage_id', userData.brokerage_id);

  if (error) {
    console.error('[settings] Error deleting commission structure:', error);
    return { error: 'Failed to delete commission structure' };
  }

  return { success: true };
}
