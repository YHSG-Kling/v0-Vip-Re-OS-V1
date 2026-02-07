'use server';

import { createServiceClient } from '@/lib/supabase/service';

export async function updateNotificationRules(id: string, updates: any) {
  const supabase = createServiceClient();
  
  const { data, error } = await supabase
    .from('notification_rules')
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();
    
  if (error) {
    console.error('[v0] Error updating notification rules:', error);
    return { error: 'Failed to update notification rules' };
  }
  
  return { data };
}
