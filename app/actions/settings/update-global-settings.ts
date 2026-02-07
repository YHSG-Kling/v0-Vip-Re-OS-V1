'use server';

import { createServiceClient } from '@/lib/supabase/service';

export async function updateGlobalSettings(updates: any) {
  const supabase = createServiceClient();
  
  const { data, error } = await supabase
    .from('global_settings')
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', updates.id)
    .select()
    .single();
    
  if (error) {
    console.error('[v0] Error updating global settings:', error);
    return { error: 'Failed to update settings' };
  }
  
  return { data };
}
