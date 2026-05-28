'use server';

import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function updateGlobalSettings(updates: any) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized' };

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .maybeSingle();
  if (!userData?.brokerage_id) return { error: 'Unauthorized' };

  const svc = createServiceClient();

  // Verify the settings row belongs to the caller's brokerage before mutating
  const { data: existing } = await svc
    .from('global_settings')
    .select('brokerage_id')
    .eq('id', updates.id)
    .maybeSingle();
  if (!existing) return { error: 'Settings not found' };
  if (existing.brokerage_id !== userData.brokerage_id) return { error: 'Forbidden' };

  const { data, error } = await svc
    .from('global_settings')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', updates.id)
    .eq('brokerage_id', userData.brokerage_id)
    .select()
    .single();

  if (error) {
    console.error('[settings] Error updating global settings:', error);
    return { error: 'Failed to update settings' };
  }

  return { data };
}
