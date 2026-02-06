'use server';

import { createClient } from '@/lib/supabase/server';
import { validateGlobalSettings } from '@/app/lib/settings/settings-validator';
import { revalidatePath } from 'next/cache';

export async function updateGlobalSettings(data: any) {
  const supabase = await createClient();

  // Get current user
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: 'Unauthorized' };
  }

  // Verify user is admin
  const { data: userProfile } = await supabase
    .from('users')
    .select('user_type, brokerage_id')
    .eq('id', user.id)
    .single();

  if (!userProfile || userProfile.user_type !== 'admin') {
    return { error: 'Only admins can update settings' };
  }

  // Validate input
  const validationErrors = validateGlobalSettings(data);
  if (validationErrors.length > 0) {
    return { error: validationErrors.join(', ') };
  }

  // Check if settings exist
  const { data: existing } = await supabase
    .from('global_settings')
    .select('id')
    .eq('brokerage_id', userProfile.brokerage_id)
    .single();

  if (existing) {
    // Update existing
    const { error } = await supabase
      .from('global_settings')
      .update({
        ...data,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);

    if (error) {
      console.error('[v0] Failed to update settings:', error);
      return { error: 'Failed to update settings' };
    }
  } else {
    // Create new
    const { error } = await supabase
      .from('global_settings')
      .insert([
        {
          ...data,
          brokerage_id: userProfile.brokerage_id,
          created_by_user_id: user.id,
        },
      ]);

    if (error) {
      console.error('[v0] Failed to create settings:', error);
      return { error: 'Failed to create settings' };
    }
  }

  revalidatePath('/settings');
  return { success: true };
}
