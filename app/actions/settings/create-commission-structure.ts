'use server';

import { createServiceClient } from '@/lib/supabase/service';

export async function createCommissionStructure(structure: any) {
  const supabase = createServiceClient();
  
  const { data, error } = await supabase
    .from('commission_structures')
    .insert({
      ...structure,
      is_active: true,
    })
    .select()
    .single();
    
  if (error) {
    console.error('[v0] Error creating commission structure:', error);
    return { error: 'Failed to create commission structure' };
  }
  
  return { data };
}
