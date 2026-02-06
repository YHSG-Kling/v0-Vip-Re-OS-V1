'use server';

import { createClient } from '@/lib/supabase/server';
import { validateCommissionStructure } from '@/app/lib/settings/settings-validator';
import { revalidatePath } from 'next/cache';

export async function updateCommissionStructure(id: string, data: any) {
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
    return { error: 'Only admins can update commission structures' };
  }

  const validationErrors = validateCommissionStructure(data);
  if (validationErrors.length > 0) {
    return { error: validationErrors.join(', ') };
  }

  const { error } = await supabase
    .from('commission_structures')
    .update({
      ...data,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('brokerage_id', userProfile.brokerage_id);

  if (error) {
    console.error('[v0] Failed to update commission structure:', error);
    return { error: 'Failed to update commission structure' };
  }

  revalidatePath('/settings/commission');
  return { success: true };
}
