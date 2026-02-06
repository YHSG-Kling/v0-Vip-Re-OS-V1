'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export async function getGlobalSettings() {
  const supabase = await createClient();

  // Get current user
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  // Verify user is admin/broker
  const { data: userProfile } = await supabase
    .from('users')
    .select('user_type, brokerage_id')
    .eq('id', user.id)
    .single();

  if (!userProfile || !['admin', 'broker'].includes(userProfile.user_type)) {
    redirect('/dashboard');
  }

  // Get global settings
  const { data: settings, error } = await supabase
    .from('global_settings')
    .select('*')
    .eq('brokerage_id', userProfile.brokerage_id)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('[v0] Failed to load settings:', error);
    throw new Error('Failed to load settings');
  }

  return settings || null;
}
