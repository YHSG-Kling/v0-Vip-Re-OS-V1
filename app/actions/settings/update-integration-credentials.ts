'use server';

import { createClient } from '@/lib/supabase/server';
import { validateIntegrationCredentials } from '@/app/lib/settings/settings-validator';
import { revalidatePath } from 'next/cache';

export async function updateIntegrationCredentials(id: string, data: any) {
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
    return { error: 'Only admins can update integration credentials' };
  }

  const validationErrors = validateIntegrationCredentials(data);
  if (validationErrors.length > 0) {
    return { error: validationErrors.join(', ') };
  }

  const { error } = await supabase
    .from('integration_credentials')
    .update({
      ...data,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('brokerage_id', userProfile.brokerage_id);

  if (error) {
    console.error('[v0] Failed to update integration credentials:', error);
    return { error: 'Failed to update integration credentials' };
  }

  revalidatePath('/settings/integrations');
  return { success: true };
}
