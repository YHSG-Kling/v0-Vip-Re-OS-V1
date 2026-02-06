'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function updateNotificationRules(id: string, data: any) {
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
    return { error: 'Only admins can update notification rules' };
  }

  const { error } = await supabase
    .from('notification_rules')
    .update({
      ...data,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('brokerage_id', userProfile.brokerage_id);

  if (error) {
    console.error('[v0] Failed to update notification rule:', error);
    return { error: 'Failed to update notification rule' };
  }

  revalidatePath('/settings/notifications');
  return { success: true };
}
