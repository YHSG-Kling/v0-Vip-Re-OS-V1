'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function deleteCommissionStructure(id: string) {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: 'Unauthorized' };
  }

  const { data: userProfile } = await supabase
    .from('users')
    .select('user_type, brokerage_id')
    .eq('id', user.id)
    .single();

  if (!userProfile || userProfile.user_type !== 'admin') {
    return { error: 'Only admins can delete commission structures' };
  }

  const { error } = await supabase
    .from('commission_structures')
    .delete()
    .eq('id', id)
    .eq('brokerage_id', userProfile.brokerage_id);

  if (error) {
    console.error('[v0] Failed to delete commission structure:', error);
    return { error: 'Failed to delete commission structure' };
  }

  revalidatePath('/settings/commission');
  return { success: true };
}
