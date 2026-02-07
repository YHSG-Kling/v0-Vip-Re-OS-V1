'use server';

import { createServiceClient } from '@/lib/supabase/service';

export async function deleteCommissionStructure(id: string) {
  const supabase = createServiceClient();
  
  const { error } = await supabase
    .from('commission_structures')
    .delete()
    .eq('id', id);
    
  if (error) {
    console.error('[v0] Error deleting commission structure:', error);
    return { error: 'Failed to delete commission structure' };
  }
  
  return { success: true };
}
