'use server';

import { createClient } from '@/lib/supabase/server';
import { validateCommissionStructure } from '@/app/lib/settings/settings-validator';
import { revalidatePath } from 'next/cache';

export async function createCommissionStructure(data: any) {
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
    return { error: 'Only admins can create commission structures' };
  }

  const validationErrors = validateCommissionStructure(data);
  if (validationErrors.length > 0) {
    return { error: validationErrors.join(', ') };
  }

  const { error } = await supabase.from('commission_structures').insert([
    {
      ...data,
      brokerage_id: userProfile.brokerage_id,
      is_active: true,
      is_default: false,
    },
  ]);

  if (error) {
    console.error('[v0] Failed to create commission structure:', error);
    return { error: 'Failed to create commission structure' };
  }

  revalidatePath('/settings/commission');
  return { success: true };
}
