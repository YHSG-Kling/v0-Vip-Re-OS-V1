'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function deleteEmailTemplate(id: string) {
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
    return { error: 'Only admins can delete email templates' };
  }

  const { error } = await supabase
    .from('email_templates')
    .delete()
    .eq('id', id)
    .eq('brokerage_id', userProfile.brokerage_id);

  if (error) {
    console.error('[v0] Failed to delete email template:', error);
    return { error: 'Failed to delete email template' };
  }

  revalidatePath('/settings/email-templates');
  return { success: true };
}
