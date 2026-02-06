'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export async function listCommissionStructures() {
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

  const { data: structures, error } = await supabase
    .from('commission_structures')
    .select('*')
    .eq('brokerage_id', userProfile.brokerage_id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[v0] Failed to load commission structures:', error);
    throw new Error('Failed to load commission structures');
  }

  return structures || [];
}
