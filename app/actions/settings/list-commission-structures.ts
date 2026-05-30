'use server';

import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function listCommissionStructures() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: u } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .maybeSingle();
  if (!u?.brokerage_id) return [];

  const svc = createServiceClient();
  const { data, error } = await svc
    .from('commission_structures')
    .select('*')
    .eq('brokerage_id', u.brokerage_id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[settings] Error fetching commission structures:', error);
    return [];
  }

  return data || [];
}
