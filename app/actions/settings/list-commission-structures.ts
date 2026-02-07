'use server';

import { createServiceClient } from '@/lib/supabase/service';

export async function listCommissionStructures() {
  const supabase = createServiceClient();
  
  const { data, error } = await supabase
    .from('commission_structures')
    .select('*')
    .order('created_at', { ascending: false });
    
  if (error) {
    console.error('[v0] Error fetching commission structures:', error);
    throw new Error('Failed to fetch commission structures');
  }
  
  return data || [];
}
