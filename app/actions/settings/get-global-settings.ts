'use server';

import { createServiceClient } from '@/lib/supabase/service';

export async function getGlobalSettings() {
  const supabase = createServiceClient();
  
  const { data, error } = await supabase
    .from('global_settings')
    .select('*')
    .single();
    
  if (error) {
    console.error('[v0] Error fetching global settings:', error);
    throw new Error('Failed to fetch global settings');
  }
  
  return data;
}
