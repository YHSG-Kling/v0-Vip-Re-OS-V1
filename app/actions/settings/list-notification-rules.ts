'use server';

import { createServiceClient } from '@/lib/supabase/service';

export async function listNotificationRules() {
  const supabase = createServiceClient();
  
  const { data, error } = await supabase
    .from('notification_rules')
    .select('*')
    .order('created_at', { ascending: false });
    
  if (error) {
    console.error('[v0] Error fetching notification rules:', error);
    throw new Error('Failed to fetch notification rules');
  }
  
  return data || [];
}
