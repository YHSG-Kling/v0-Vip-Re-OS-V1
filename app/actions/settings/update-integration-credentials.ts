'use server';

import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function updateIntegrationCredentials(id: string, updates: any) {
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

  // Verify the credential row belongs to the caller's brokerage before mutating
  const { data: existing } = await svc
    .from('integration_credentials')
    .select('brokerage_id')
    .eq('id', id)
    .maybeSingle();
  if (!existing) return { error: 'Credential not found' };
  if (existing.brokerage_id !== userData.brokerage_id) return { error: 'Forbidden' };

  const { data, error } = await svc
    .from('integration_credentials')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('brokerage_id', userData.brokerage_id)
    .select('id, provider_name, webhook_url, is_active, created_at, updated_at')
    .single();

  if (error) {
    console.error('[settings] Error updating integration credentials:', error);
    return { error: 'Failed to update integration credentials' };
  }

  return { data };
}
