'use server';

import { createServiceClient } from '@/lib/supabase/service';

export async function updateIntegrationCredentials(id: string, updates: any) {
  const supabase = createServiceClient();
  
  const { data, error } = await supabase
    .from('integration_credentials')
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id, provider_name, webhook_url, is_active, created_at, updated_at')
    .single();
    
  if (error) {
    console.error('[v0] Error updating integration credentials:', error);
    return { error: 'Failed to update integration credentials' };
  }
  
  return { data };
}
