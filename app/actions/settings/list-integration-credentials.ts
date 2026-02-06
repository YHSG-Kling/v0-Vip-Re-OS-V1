'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export async function listIntegrationCredentials() {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  const { data: userProfile } = await supabase
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .single();

  if (!userProfile || !['admin', 'broker'].includes(userProfile.user_type)) {
    redirect('/dashboard');
  }

  const { data: credentials, error } = await supabase
    .from('integration_credentials')
    .select('*')
    .eq('brokerage_id', userProfile.brokerage_id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[v0] Failed to load integration credentials:', error);
    throw new Error('Failed to load integration credentials');
  }

  return credentials || [];
}
