'use server';

import { createServiceClient } from '@/lib/supabase/service';

export async function listIntegrationCredentials() {
  const supabase = createServiceClient();
  
  const { data, error } = await supabase
    .from('integration_credentials')
    .select('id, provider_name, webhook_url, is_active, created_at, updated_at')
    .order('created_at', { ascending: false});
    
  if (error) {
    console.error('[v0] Error fetching integration credentials:', error);
    throw new Error('Failed to fetch integration credentials');
  }
  
  return data || [];
}
